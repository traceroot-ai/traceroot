'use client';

import { useState, useEffect } from 'react';

interface User {
  email?: string;
  name?: string;
}

export function useUser() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadUserFromStorage = () => {
    try {
      const userData = localStorage.getItem('user');
      if (userData) {
        const parsedUser = JSON.parse(userData);
        setUser(parsedUser);
      } else {
        setUser(null);
      }
    } catch (error) {
      console.error('Error parsing user data from localStorage:', error);
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // Load user data on hook initialization
    loadUserFromStorage();

    // Listen for storage changes (for cross-tab synchronization)
    // It's async that user credentials are updated to the storage which can be very late
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'user') {
        loadUserFromStorage();
      }
    };

    // Listen for custom storage events (for same-tab updates)
    const handleCustomStorageChange = () => {
      loadUserFromStorage();
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('userDataUpdated', handleCustomStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('userDataUpdated', handleCustomStorageChange);
    };
  }, []);

  const logout = () => {
    localStorage.removeItem('user');
    localStorage.removeItem('auth_state');
    setUser(null);
    window.dispatchEvent(new CustomEvent('userDataUpdated'));
  };

  const getAuthState = () => {
    return localStorage.getItem('auth_state');
  };

  const avatarLetter = user?.email?.charAt(0)?.toUpperCase() || null;

  return {
    user,
    isLoading,
    avatarLetter,
    logout,
    getAuthState,
    isAuthenticated: !!user
  };
}
