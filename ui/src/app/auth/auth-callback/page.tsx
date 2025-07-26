'use client';

import { useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function AuthCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const handleCallback = async () => {
      try {
        const state = searchParams.get('state');
        if (!state) {
          throw new Error('No state parameter found');
        }

        // Store the state parameter for use as user_secret
        localStorage.setItem('auth_state', state);

        // Get the auth endpoint from environment variable
        const authEndpoint = process.env.NEXT_PUBLIC_AUTH_ENDPOINT || 'http://localhost:8000';

        // Send the state to your backend
        const response = await fetch(`${authEndpoint}/v1/auth/auth-callback?` +
          new URLSearchParams({ state }).toString(), {
          method: 'GET',
          credentials: 'include', // Important for cookies
        });

        if (!response.ok) {
          throw new Error('Authentication failed');
        }

        const data = await response.json();

        // Store any necessary data from the response
        // For example, you might want to store the user info in local storage
        if (data.user) {
          localStorage.setItem('user', JSON.stringify(data.user));

          // Dispatch custom event to notify components about the user data update
          window.dispatchEvent(new CustomEvent('userDataUpdated'));
        }

        // Add a small delay to ensure localStorage is properly set and components can react
        await new Promise(resolve => setTimeout(resolve, 100));

        // Redirect to the main page or dashboard
        router.push('/');
      } catch (error) {
        console.error('Auth callback error:', error);
        // Redirect to error page or show error message
        router.push('/?error=auth_failed');
      }
    };

    handleCallback();
  }, [searchParams, router]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h2 className="text-2xl font-semibold mb-4">Completing authentication...</h2>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto"></div>
      </div>
    </div>
  );
}

export default function AuthCallback() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h2 className="text-2xl font-semibold mb-4">Loading...</h2>
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto"></div>
        </div>
      </div>
    }>
      <AuthCallbackContent />
    </Suspense>
  );
}
