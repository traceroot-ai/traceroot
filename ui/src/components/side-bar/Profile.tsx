'use client';

import { FaUser } from 'react-icons/fa';
import { RxCross1 } from 'react-icons/rx';
import { useUser } from '../../hooks/useUser';
import { useState, useEffect } from 'react';

export default function Profile() {
  const { user, avatarLetter, isLoading, logout } = useUser();
  const [showPopup, setShowPopup] = useState(false);

  // Handle ESC key to close popup
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && showPopup) {
        setShowPopup(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showPopup]);

  const handleProfileClick = () => {
    setShowPopup(true);
  };

  const closePopup = () => {
    setShowPopup(false);
  };

  const handleSignOut = () => {
    logout();
    setShowPopup(false);
    window.location.href = 'https://auth.traceroot.ai/';
  };

  if (isLoading) {
    return (
      <div className="pb-5 pt-1 flex justify-center">
        <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center animate-pulse">
          <div className="w-4 h-4 bg-gray-300 dark:bg-gray-600 rounded-full"></div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="pb-5 pt-1 flex justify-center">
        <div
          key={`avatar-${avatarLetter || 'no-letter'}`}
          className="w-12 h-12 rounded-full bg-green-50 dark:bg-green-900/10 flex items-center justify-center hover:bg-green-100 dark:hover:bg-green-900/20 transition-colors cursor-pointer"
          title="User Profile"
          onClick={handleProfileClick}
        >
          {avatarLetter ? (
            <span
              className="text-green-600 dark:text-green-400 font-semibold text-xl"
              style={{ zIndex: 100 }}
            >
              {avatarLetter}
            </span>
          ) : (
            <FaUser
              className="text-gray-600 dark:text-gray-400"
              size={18}
            />
          )}
        </div>
      </div>

      {/* Profile Popup */}
      {showPopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={closePopup}>
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 min-w-[300px] max-w-[400px] mx-4 relative"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={closePopup}
              className="absolute top-4 right-4 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="Close"
            >
              <RxCross1 className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            </button>

            {/* Profile content */}
            <div className="text-center">
              <div className="w-14 h-14 rounded-full bg-green-50 dark:bg-green-900/10 flex items-center justify-center mx-auto mb-4">
                {avatarLetter ? (
                  <span className="text-green-600 dark:text-green-400 font-semibold text-xl">
                    {avatarLetter}
                  </span>
                ) : (
                  <FaUser className="text-gray-600 dark:text-gray-400" size={20} />
                )}
              </div>

              <div className="text-gray-900 dark:text-gray-100 mb-6">
                {user?.email ? (
                  <p className="text-md font-medium">
                    Hello {user.email}!
                  </p>
                ) : (
                  <p className="text-md font-medium">
                    Please register or login! :)
                  </p>
                )}
              </div>

              {/* Sign Out Button */}
              {user && (
                <button
                  onClick={handleSignOut}
                  className="w-full px-4 py-2 bg-red-500 hover:bg-red-600 text-white font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                >
                  Sign Out
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
