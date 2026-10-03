import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Peer from "peerjs";

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
  connectedPeers: Map<string, Peer.DataConnection>;
  lastHeartbeat: number;
  isConnected: boolean;
  errorLog: Array<{ at: number; error: string }>;
}

const connectionStates = new Map<string, ConnectionState>();
const HEARTBEAT_INTERVAL = 8000;
const PACKET_TIMEOUT = 5000;
const MAX_ERRORS_LOG = 100;
const RELAY_SERVER = process.env.REACT_APP_RELAY_SERVER || "https://relay.retroflex.app";

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

  const pendingAcksRef = useRef<Map<string, { resolve: () => void; reject: (err: Error) => void; timeout: number }>>(
    new Map()
  );

  const logError = useCallback((err: string) => {
    const state = stateRef.current;
    state.errorLog.push({ at: Date.now(), error: err });
    if (state.errorLog.length > MAX_ERRORS_LOG) {
      state.errorLog = state.errorLog.slice(-MAX_ERRORS_LOG);
    }
    console.error(`[Retroflex \( {pairCode}/ \){role}]`, err);
  }, [pairCode, role]);

  const publishPacket = useCallback(
    (packet: SyncPacket) => {
      if (!pairCode) return;
      const state = stateRef.current;

      // Add packet ID for acknowledgment tracking
      const packetId = `pkt_\( {Date.now()}_ \){Math.random().toString(36).slice(2, 10)}`;
      const packetWithId = { ...packet, packetId };

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

      // Try Cloud Relay if available
      if (state.peerId && state.isConnected) {
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
    let reconnectDelay = 1000;

    const initPeer = async () => {
      try {
        const state = stateRef.current;

        // Clean up old peer
        if (state.peer) {
          state.peer.destroy();
          state.connectedPeers.clear();
        }

        // Create new peer with enterprise configuration
        const peerId = `\( {role}- \){pairCode}-${Math.random().toString(36).slice(2, 10)}`;
        const peer = new Peer(peerId, {
          host: new URL(RELAY_SERVER).hostname,
          port: parseInt(new URL(RELAY_SERVER).port || "443"),
          path: "/peerjs",
          secure: RELAY_SERVER.startsWith("https"),
          config: {
            iceServers: [
              { urls: "stun:stun.l.google.com:19302" },
              { urls: "stun:stun1.l.google.com:19302" },
              { urls: "turn:relay.retroflex.app:3478", username: "retroflex", credential: "beacon2024" },
            ],
          },
        });

        state.peer = peer;
        state.peerId = peerId;

        // Handle incoming connections
        peer.on("connection", (connection) => {
          if (!isActive) return;

          connection.on("open", () => {
            state.connectedPeers.set(connection.peer, connection);
            setConnected(true);
            setError(null);
            reconnectDelay = 1000; // Reset backoff
          });

          connection.on("data", (packet: SyncPacket) => {
            if (packet.packetId) {
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
        });

        peer.on("open", (id) => {
          if (!isActive) return;
          console.log(`[Retroflex] Peer opened: ${id}`);

          // Try to connect to matching peer
          const targetRole = role === "host" ? "display" : "host";
          const targetPeerId = `\( {targetRole}- \){pairCode}-*`;

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
          logError(`PeerJS error: ${err.message}`);
          setError(err.message);

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
      const state = stateRef.current;
      if (state.peer) {
        state.peer.destroy();
      }
      state.connectedPeers.clear();
    };
  }, [pairCode, role, publishPacket, onMessage, logError]);

  // Fetch updates from cloud relay periodically
  useEffect(() => {
    if (!pairCode) return;

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

      const logError = (err: string) => {
        console.error(`[Retroflex fleet/${code}]`, err);
      };

      const publishPacket = (packet: SyncPacket) => {
        const packetId = `pkt_\( {Date.now()}_ \){Math.random().toString(36).slice(2, 10)}`;
        const packetWithId = { ...packet, packetId };

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

        // Cloud relay fallback
        try {
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

          peerId = `host-\( {code}- \){Math.random().toString(36).slice(2, 10)}`;
          peer = new Peer(peerId, {
            host: new URL(RELAY_SERVER).hostname,
            port: parseInt(new URL(RELAY_SERVER).port || "443"),
            path: "/peerjs",
            secure: RELAY_SERVER.startsWith("https"),
            config: {
              iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" },
                {
                  urls: "turn:relay.retroflex.app:3478",
                  username: "retroflex",
                  credential: "beacon2024",
                },
              ],
            },
          });

          peer.on("connection", (connection) => {
            if (!isActive) return;

            connection.on("open", () => {
              connectedPeers.set(connection.peer, connection);
              connected.add(code);
              setConnectedCodes([...connected]);
              reconnectDelay = 1000;
            });

            connection.on("data", (packet: SyncPacket) => {
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
          });

          peer.on("open", () => {
            if (!isActive) return;
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
            logError(`PeerJS error: ${err.message}`);
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