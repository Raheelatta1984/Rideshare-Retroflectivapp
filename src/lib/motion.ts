import { useEffect, useState } from "react";
import type { MotionState } from "../types";

export function kph(mps: number): number {
  return mps * 3.6;
}

export function useMotion(
  enabled: boolean,
  demoStopped: boolean = false,
  stationarySpeedThresholdKph: number = 0.5,
): MotionState {
  const [motion, setMotion] = useState<MotionState>({
    isStationary: true,
    speedMps: 0,
    stoppedForMs: 0,
    allowed: true,
  });

  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !navigator.geolocation) {
      setMotion({
        isStationary: true,
        speedMps: 0,
        stoppedForMs: 0,
        allowed: false,
      });
      return;
    }

    if (demoStopped) {
      setMotion({
        isStationary: true,
        speedMps: 0,
        stoppedForMs: 0,
        allowed: true,
      });
      return;
    }

    const thresholdMps = stationarySpeedThresholdKph / 3.6;
    let lastCoords: GeolocationCoordinates | null = null;
    let lastAt: number | null = null;
    let stoppedAt: number | null = null;
    let watchId: number | null = null;

    const update = (position: GeolocationPosition) => {
      const now = Date.now();
      let speedMps = 0;

      if (lastCoords && lastAt) {
        const distance = distanceMeters(lastCoords, position.coords);
        const elapsed = (now - lastAt) / 1000; // seconds
        if (elapsed > 0) speedMps = distance / elapsed;
      }

      const isStationary = speedMps < thresholdMps;

      if (isStationary) {
        if (stoppedAt === null) stoppedAt = now;
      } else {
        stoppedAt = null;
      }

      setMotion({
        isStationary,
        speedMps,
        stoppedForMs: stoppedAt ? now - stoppedAt : 0,
        allowed: true,
      });

      lastCoords = position.coords;
      lastAt = now;
    };

    watchId = navigator.geolocation.watchPosition(
      update,
      () => {
        setMotion({
          isStationary: true,
          speedMps: 0,
          stoppedForMs: 0,
          allowed: false,
        });
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000,
      },
    );

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [enabled, demoStopped, stationarySpeedThresholdKph]);

  return motion;
}

function distanceMeters(
  a: GeolocationCoordinates,
  b: GeolocationCoordinates,
): number {
  const earthRadius = 6371000; // meters
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;

  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return earthRadius * c;
}