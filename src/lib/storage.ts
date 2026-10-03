// Local storage database for tablet activity and user data
export const db = {
  listTabletActivity: (code: string, deviceId: string) => {
    // Get stored activity from localStorage for this tablet
    const key = `rf:tablet-activity:${code}:${deviceId}`;
    const stored = localStorage.getItem(key);
    
    if (!stored) {
      return [];
    }
    
    try {
      return JSON.parse(stored) as Array<{
        id: string;
        action: string;
        at: number;
        details?: Record<string, unknown>;
      }>;
    } catch {
      return [];
    }
  },

  addTabletActivity: (code: string, deviceId: string, action: string, details?: Record<string, unknown>) => {
    const key = `rf:tablet-activity:${code}:${deviceId}`;
    const stored = localStorage.getItem(key);
    
    let activities: Array<{
      id: string;
      action: string;
      at: number;
      details?: Record<string, unknown>;
    }> = [];
    
    if (stored) {
      try {
        activities = JSON.parse(stored);
      } catch {
        activities = [];
      }
    }
    
    activities.push({
      id: `${Date.now()}-${Math.random()}`,
      action,
      at: Date.now(),
      details,
    });
    
    // Keep only last 100 entries
    if (activities.length > 100) {
      activities = activities.slice(-100);
    }
    
    localStorage.setItem(key, JSON.stringify(activities));
  },
};