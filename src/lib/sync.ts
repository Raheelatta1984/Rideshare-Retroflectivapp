import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Peer, { type DataConnection } from "peerjs";
import { packetId as makePacketId, peerId as makePeerId, relayTag } from "./id";

export interface SyncPacket {
  type: "hello" | "settings" | "ride" | "motion" | "battery" | "activity" | "telemetry" | "ack";
  device?: { id: string; name: string; pairCode: string; position: "rear" | "front"; lastSeen: number };
  settings?: any;
  ride?: any;
  motion?: any;
  battery?: any;
  activity?: any;
  telemetry?: any;
  targetDeviceId?: string;
  packetId?: string;
  acknowledges?: string;
}

interface ConnectionState {
  broadcastChannel: BroadcastChannel | null;
  peer: Peer | null;
  peerId: string | null;
  connectedPeers: Map<string, DataConnection>;
  lastHeartbeat: number;
  isConnected: boolean;
  errorLog: Array<{ at: number; error: string }>;
}

const HEARTBEAT_INTERVAL = 8000;
const MAX_ERRORS_LOG = 100;
/** How often a host retries dialling the tablet while unconnected. */
const DIAL_RETRY_MS = 4000;
/** How long to wait for a tablet to claim its peer id after a peer-unavailable. */
const PEER_UNAVAILABLE_RETRY_MS = 1500;

/**
 * Optional self-hosted relay + PeerJS host.
 *
 * Set VITE_RELAY_SERVER at build time (Vercel → Project → Settings → Environment
 * Variables) to enable the HTTP relay AND use your own PeerJS server. When it is
 * unset the app signals over the public PeerJS cloud and never attempts relay
 * traffic.
 *
 * History: this constant used to read `process.env.REACT_APP_RELAY_SERVER`,
 * which is a Create-React-App convention — Vite only exposes `import.meta.env`.
 * The value was therefore never configurable, and the hard-coded fallback
 * `relay.retroflex.app` does not resolve in DNS, so every relay request and the
 * TURN credential pair below were dead weight. The hard-coded TURN password
 * (retroflex / beacon2024) has been removed; pass your own via env if needed.
 */
const RELAY_SERVER = (import.meta.env.VITE_RELAY_SERVER as string | undefined) ?? "";

function relayHostname(value: string): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function relayPort(value: string, fallback: number): number {
  if (!value) return fallback;
  try {
    return Number(new URL(value).port) || fallback;
  } catch {
    return fallback;
  }
}

const PEER_HOST =
  (import.meta.env.VITE_PEER_HOST as string | undefined) || relayHostname(RELAY_SERVER) || "0.peerjs.com";
const PEER_PORT = Number(import.meta.env.VITE_PEER_PORT) || relayPort(RELAY_SERVER, 443);
const PEER_PATH = (import.meta.env.VITE_PEER_PATH as string | undefined) || "/";
const PEER_SECURE = PEER_PORT === 443 || RELAY_SERVER.startsWith("https");

const TURN_URL = import.meta.env.VITE_TURN_URL as string | undefined;

const PEER_OPTIONS = {
  host: PEER_HOST,
  port: PEER_PORT,
  path: PEER_PATH,
  secure: PEER_SECURE,
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      ...(TURN_URL
        ? [
            {
              urls: TURN_URL,
              username: import.meta.env.VITE_TURN_USERNAME as string | undefined,
              credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
            },
          ]
        : []),
    ],
  },
};

/**
 * Enterprise-grade sync layer for Retroflex devices
 * - BroadcastChannel for same-browser communication
 * - PeerJS with STUN/TURN servers for cross-device
 * - Cloud relay server for NAT traversal
 * - Automatic reconnection with exponential backoff
 * - Persistent activity logging
 */
export function usePairChannel(
  pairCode: string | undefined,
  role: "host" | "display",
  onMessage?: (packet: SyncPacket) => void
) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<ConnectionState>({
    broadcastChannel: null,
    peer: null,
    peerId: null,
    connectedPeers: new Map(),
    lastHeartbeat: 0,
    isConnected: false,
    errorLog: [],
  });

  const logError = useCallback((err: string) => {
    const state = stateRef.current;
    state.errorLog.push({ at: Date.now(), error: err });
    if (state.errorLog.length > MAX_ERRORS_LOG) {
      state.errorLog = state.errorLog.slice(-MAX_ERRORS_LOG);
    }
    console.error(relayTag(pairCode, role), err);
  }, [pairCode, role]);

  const publishPacket = useCallback(
    (packet: SyncPacket) => {
      if (!pairCode) return;
      const state = stateRef.current;

      // Add packet ID for acknowledgment tracking
      const nextPacketId = makePacketId();
      const packetWithId = { ...packet, packetId: nextPacketId };

      // Try BroadcastChannel first (same browser)
      if (state.broadcastChannel) {
        try {
          state.broadcastChannel.postMessage(packetWithId);
        } catch (err) {
          logError(`BroadcastChannel postMessage failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Try PeerJS (cross-device)
      if (state.connectedPeers.size > 0) {
        for (const [peerId, connection] of state.connectedPeers) {
          try {
            if (connection.open) {
              connection.send(packetWithId);
            } else {
              state.connectedPeers.delete(peerId);
            }
          } catch (err) {
            logError(`PeerJS send to ${peerId} failed: ${err instanceof Error ? err.message : String(err)}`);
            state.connectedPeers.delete(peerId);
          }
        }
      }

      // Try Cloud Relay if one is configured (VITE_RELAY_SERVER)
      if (RELAY_SERVER && state.peerId && state.isConnected) {
        try {
          fetch(`${RELAY_SERVER}/relay`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pairCode,
              fromRole: role,
              packet: packetWithId,
              timestamp: Date.now(),
            }),
          }).catch(() => undefined); // Fire and forget
        } catch (err) {
          // Silently fail - relay is optional
        }
      }
    },
    [pairCode, role, logError]
  );

  // Initialize BroadcastChannel
  useEffect(() => {
    if (!pairCode) return;

    try {
      const state = stateRef.current;
      const channelName = `retroflex-${pairCode}`;

      if (state.broadcastChannel) {
        state.broadcastChannel.close();
      }

      const bc = new BroadcastChannel(channelName);
      state.broadcastChannel = bc;

      const handleMessage = (event: MessageEvent<SyncPacket>) => {
        const packet = event.data;
        if (packet.packetId) {
          // Send acknowledgment
          bc.postMessage({ type: "ack", acknowledges: packet.packetId });
        }
        onMessage?.(packet);
      };

      const handleError = (event: Event) => {
        logError(`BroadcastChannel error: ${(event as ErrorEvent).message}`);
      };

      bc.addEventListener("message", handleMessage);
      bc.addEventListener("messageerror", handleError);

      setConnected(true);
      setError(null);

      return () => {
        bc.removeEventListener("message", handleMessage);
        bc.removeEventListener("messageerror", handleError);
        bc.close();
      };
    } catch (err) {
      logError(`BroadcastChannel initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [pairCode, onMessage, logError]);

  // Initialize PeerJS with cloud relay
  useEffect(() => {
    if (!pairCode) return;

    let isActive = true;
    let reconnectTimeout: number | null = null;
    let heartbeatInterval: number | null = null;
    let dialTimer: number | null = null;
    let idCollision = false;
    let dial: (() => void) | null = null;
    let reconnectDelay = 1000;

    const initPeer = async () => {
      try {
        const state = stateRef.current;

        // Clean up old peer
        if (state.peer) {
          state.peer.destroy();
          state.connectedPeers.clear();
        }

        // Deterministic, dialable peer identity: retroflex-<CODE>-<role>.
        // The other side has to be able to find us without peer discovery,
        // so the id is derived from the pair code instead of random.
        const basePeerId = makePeerId(role, pairCode);
        const peerId = idCollision ? `${basePeerId}-${Math.random().toString(36).slice(2, 6)}` : basePeerId;
        const peer = new Peer(peerId, PEER_OPTIONS);

        state.peer = peer;
        state.peerId = peerId;

        // One wiring path for both incoming and outgoing connections.
        const wireConnection = (connection: DataConnection) => {
          connection.on("open", () => {
            state.connectedPeers.set(connection.peer, connection);
            setConnected(true);
            setError(null);
            reconnectDelay = 1000; // Reset backoff
            console.log(`[Retroflex] Peer connected: ${connection.peer}`);
          });

          connection.on("data", (data: unknown) => {
            const packet = data as SyncPacket;
            if (packet?.packetId) {
              // Send acknowledgment
              try {
                connection.send({ type: "ack", acknowledges: packet.packetId });
              } catch (err) {
                logError(`Failed to send ack: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            onMessage?.(packet);
          });

          connection.on("close", () => {
            state.connectedPeers.delete(connection.peer);
            if (state.connectedPeers.size === 0) {
              setConnected(false);
            }
          });

          connection.on("error", (err) => {
            logError(`PeerJS connection error: ${err.message}`);
            state.connectedPeers.delete(connection.peer);
          });
        };

        // Handle incoming connections (the tablet is dialled, so this is its
        // side of the pair; the phone also accepts if the tablet dials back).
        peer.on("connection", (connection) => {
          if (!isActive) return;
          wireConnection(connection);
        });

        peer.on("open", (id) => {
          if (!isActive) return;
          console.log(`[Retroflex] Peer opened: ${id}`);

          // Dial the other half of the pair. PeerJS exposes no peer discovery,
          // so the target id must be known up-front — this is the connection
          // the previous build constructed a wildcard for and never opened.
          const targetRole: "host" | "display" = role === "host" ? "display" : "host";
          const targetPeerId = makePeerId(targetRole, pairCode);

          dial = () => {
            if (!isActive || state.connectedPeers.size > 0) return;
            try {
              wireConnection(peer.connect(targetPeerId, { reliable: true }));
            } catch (err) {
              logError(`Dial ${targetPeerId} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          };

          dial();
          dialTimer = window.setInterval(() => dial?.(), DIAL_RETRY_MS);

          // Heartbeat to announce presence
          heartbeatInterval = window.setInterval(() => {
            publishPacket({
              type: "hello",
              device: {
                id: peerId,
                name: `${role} device`,
                pairCode,
                position: role === "display" ? "rear" : "front",
                lastSeen: Date.now(),
              },
            });
            state.lastHeartbeat = Date.now();
          }, HEARTBEAT_INTERVAL);
        });

        peer.on("error", (err) => {
          const type = (err as { type?: string }).type;

          // Expected while the other device is still booting / offline:
          // keep the channel alive and simply dial again shortly.
          if (type === "peer-unavailable") {
            reconnectTimeout = window.setTimeout(() => {
              if (isActive) dial?.();
            }, PEER_UNAVAILABLE_RETRY_MS);
            return;
          }

          logError(`PeerJS error: ${err.message}`);
          setError(err.message);

          // Our deterministic id is already claimed (another tab or device
          // with the same pair code). Fall back to a suffixed id rather than
          // dropping the channel.
          if (type === "unavailable-id" && !idCollision) {
            idCollision = true;
            reconnectTimeout = window.setTimeout(() => {
              if (isActive) void initPeer();
            }, 500);
            return;
          }

          // Exponential backoff reconnection
          if (isActive && reconnectDelay < 30000) {
            reconnectTimeout = window.setTimeout(() => {
              if (isActive) initPeer();
            }, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
          }
        });
      } catch (err) {
        logError(`PeerJS initialization error: ${err instanceof Error ? err.message : String(err)}`);
        if (isActive && reconnectDelay < 30000) {
          reconnectTimeout = window.setTimeout(initPeer, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
        }
      }
    };

    initPeer();

    return () => {
      isActive = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (dialTimer) clearInterval(dialTimer);
      const state = stateRef.current;
      if (state.peer) {
        state.peer.destroy();
      }
      state.connectedPeers.clear();
    };
  }, [pairCode, role, publishPacket, onMessage, logError]);

  // Fetch updates from cloud relay periodically (only when one is configured)
  useEffect(() => {
    if (!pairCode || !RELAY_SERVER) return;

    const pollRelay = async () => {
      try {
        const response = await fetch(`${RELAY_SERVER}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairCode, role, since: Date.now() - 5000 }),
        });

        if (response.ok) {
          const packets = await response.json();
          packets.forEach((packet: SyncPacket) => {
            if (packet.packetId) {
              // Acknowledge receipt
              fetch(`${RELAY_SERVER}/ack`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pairCode, packetId: packet.packetId }),
              }).catch(() => undefined);
            }
            onMessage?.(packet);
          });
        }
      } catch (err) {
        // Silently fail - relay polling is optional fallback
      }
    };

    const interval = setInterval(pollRelay, 3000);
    return () => clearInterval(interval);
  }, [pairCode, role, onMessage]);

  return {
    publish: publishPacket,
    connected,
    error,
    errorLog: stateRef.current.errorLog,
    diagnostics: {
      broadcastChannel: !!stateRef.current.broadcastChannel,
      peerConnections: stateRef.current.connectedPeers.size,
      peerId: stateRef.current.peerId,
      lastHeartbeat: stateRef.current.lastHeartbeat,
    },
  };
}

/**
 * Multi-pair fleet channel manager used by DriverConsole.
 * Uses the same BroadcastChannel + PeerJS + relay stack as usePairChannel
 * so phone ↔ tablet works across real devices.
 */
export function useFleetChannels(
  pairCodes: string[],
  onMessage?: (packet: SyncPacket, pairCode: string) => void
) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const publishersRef = useRef<Map<string, (packet: SyncPacket) => void>>(new Map());
  const [connectedCodes, setConnectedCodes] = useState<string[]>([]);

  const codes = useMemo(
    () => [...new Set(pairCodes.filter(Boolean))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pairCodes.join("|")]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const cleanups: Array<() => void> = [];
    const nextPublishers = new Map<string, (packet: SyncPacket) => void>();
    const connected = new Set<string>();

    for (const code of codes) {
      const channelName = `retroflex-${code}`;
      let bc: BroadcastChannel | null = null;
      let peer: Peer | null = null;
      let peerId: string | null = null;
      const connectedPeers = new Map<string, any>();
      let heartbeatInterval: number | null = null;
      let reconnectTimeout: number | null = null;
      let reconnectDelay = 1000;
      let isActive = true;
      let dialTimer: number | null = null;
      let idCollision = false;
      let dial: (() => void) | null = null;

      const logError = (err: string) => {
        console.error(`[Retroflex fleet/${code}]`, err);
      };

      const publishPacket = (packet: SyncPacket) => {
        const nextPacketId = makePacketId();
        const packetWithId = { ...packet, packetId: nextPacketId };

        // BroadcastChannel (same browser / same origin tabs)
        if (bc) {
          try {
            bc.postMessage(packetWithId);
          } catch (err) {
            logError(`BroadcastChannel post failed: ${err}`);
          }
        }

        // PeerJS (real phone ↔ tablet)
        for (const [id, conn] of connectedPeers) {
          try {
            if (conn.open) {
              conn.send(packetWithId);
            } else {
              connectedPeers.delete(id);
            }
          } catch (err) {
            logError(`PeerJS send failed: ${err}`);
            connectedPeers.delete(id);
          }
        }

        // Cloud relay fallback (only when VITE_RELAY_SERVER is configured)
        if (RELAY_SERVER) try {
          fetch(`${RELAY_SERVER}/relay`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pairCode: code,
              fromRole: "host",
              packet: packetWithId,
              timestamp: Date.now(),
            }),
          }).catch(() => undefined);
        } catch {
          // optional
        }
      };

      nextPublishers.set(code, publishPacket);

      // --- BroadcastChannel ---
      try {
        bc = new BroadcastChannel(channelName);
        bc.addEventListener("message", (event: MessageEvent<SyncPacket>) => {
          const packet = event.data;
          if (packet?.packetId) {
            try {
              bc?.postMessage({ type: "ack", acknowledges: packet.packetId });
            } catch {
              // ignore
            }
          }
          onMessageRef.current?.(packet, code);
        });
        connected.add(code);
      } catch (err) {
        logError(`BroadcastChannel init failed: ${err}`);
      }

      // --- PeerJS ---
      const initPeer = () => {
        if (!isActive) return;
        try {
          if (peer) {
            peer.destroy();
            connectedPeers.clear();
          }

          // Deterministic host identity per pair code, so the tablet can dial
          // back if it is the one that comes online first.
          const basePeerId = makePeerId("host", code);
          peerId = idCollision ? `${basePeerId}-${Math.random().toString(36).slice(2, 6)}` : basePeerId;
          peer = new Peer(peerId, PEER_OPTIONS);

          // Shared wiring for incoming and outgoing connections.
          const wireConnection = (connection: DataConnection) => {
            connection.on("open", () => {
              connectedPeers.set(connection.peer, connection);
              connected.add(code);
              setConnectedCodes([...connected]);
              reconnectDelay = 1000;
            });

            connection.on("data", (data: unknown) => {
              const packet = data as SyncPacket;
              if (packet?.packetId) {
                try {
                  connection.send({ type: "ack", acknowledges: packet.packetId });
                } catch {
                  // ignore
                }
              }
              onMessageRef.current?.(packet, code);
            });

            connection.on("close", () => {
              connectedPeers.delete(connection.peer);
            });

            connection.on("error", (err) => {
              logError(`Peer connection error: ${err.message}`);
              connectedPeers.delete(connection.peer);
            });
          };

          peer.on("connection", (connection) => {
            if (!isActive) return;
            wireConnection(connection);
          });

          peer.on("open", () => {
            if (!isActive) return;

            // Dial the tablet for this pair code. Hooks are exclusive: the
            // phone dials the display, and the display accepts (plus dials
            // back if it started first).
            const targetPeerId = makePeerId("display", code);
            dial = () => {
              if (!isActive || connectedPeers.size > 0) return;
              try {
                wireConnection(peer!.connect(targetPeerId, { reliable: true }));
              } catch (err) {
                logError(`Dial ${targetPeerId} failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            };

            dial();
            dialTimer = window.setInterval(() => dial?.(), DIAL_RETRY_MS);

            // Heartbeat so tablet sees the host
            heartbeatInterval = window.setInterval(() => {
              publishPacket({
                type: "hello",
                device: {
                  id: peerId!,
                  name: "Driver phone",
                  pairCode: code,
                  position: "front",
                  lastSeen: Date.now(),
                },
              });
            }, HEARTBEAT_INTERVAL);
          });

          peer.on("error", (err) => {
            const type = (err as { type?: string }).type;

            // Tablet not online yet — retry quietly without tearing the peer down.
            if (type === "peer-unavailable") {
              reconnectTimeout = window.setTimeout(() => {
                if (isActive) dial?.();
              }, PEER_UNAVAILABLE_RETRY_MS);
              return;
            }

            logError(`PeerJS error: ${err.message}`);

            if (type === "unavailable-id" && !idCollision) {
              idCollision = true;
              reconnectTimeout = window.setTimeout(() => {
                if (isActive) initPeer();
              }, 500);
              return;
            }

            if (isActive && reconnectDelay < 30000) {
              reconnectTimeout = window.setTimeout(() => {
                if (isActive) initPeer();
              }, reconnectDelay);
              reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
            }
          });
        } catch (err) {
          logError(`PeerJS init failed: ${err}`);
          if (isActive && reconnectDelay < 30000) {
            reconnectTimeout = window.setTimeout(initPeer, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
          }
        }
      };

      initPeer();

      cleanups.push(() => {
        isActive = false;
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (dialTimer) clearInterval(dialTimer);
        try {
          bc?.close();
        } catch {
          // ignore
        }
        try {
          peer?.destroy();
        } catch {
          // ignore
        }
        connectedPeers.clear();
      });
    }

    publishersRef.current = nextPublishers;
    setConnectedCodes([...connected]);

    return () => {
      cleanups.forEach((fn) => fn());
      publishersRef.current.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codes.join("|")]);

  const publishTo = useCallback((pairCode: string, packet: SyncPacket) => {
    publishersRef.current.get(pairCode)?.(packet);
  }, []);

  const publishAll = useCallback(
    (builder: (pairCode: string) => SyncPacket) => {
      for (const code of publishersRef.current.keys()) {
        publishTo(code, builder(code));
      }
    },
    [publishTo]
  );

  return {
    publishTo,
    publishAll,
    connectedCodes,
  };
}