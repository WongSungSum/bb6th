'use client';
import { useState } from 'react';

interface UsersProps {
  initialData: any[];
}

export default function Users({ initialData }: UsersProps) {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredUsers = initialData.filter((user) =>
    user.fullName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    user.username?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="w-full">

      {/* Sticky search bar */}
      <div className="sticky top-0 md:top-[64px] z-20 px-4 py-4">
        <input
          className="w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          type="text"
          placeholder="Search members..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>
        {/* Gradient mask */}
        
        <div
            className="sticky z-10 pointer-events-none bg-gradient-to-b from-white dark:from-gray-950 to-transparent md:top-[120px] top-[56px]"
            style={{
                height: '64px',
            }}
        />
      {/* Cards list — only once! */}
      <div className="px-4 pb-8">
        {filteredUsers.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">
            No members found
          </div>
        ) : (
          filteredUsers.map((user) => (
            <div
              key={user.id}
              className="relative bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm hover:shadow-md transition-shadow overflow-hidden mb-3"
            >
              {/* Top color bar */}
              <div className="h-2 bg-blue-600 w-full" />

              <div className="p-5">
                <div className="flex items-center space-x-4">
                  {/* Avatar */}
                  <div className="h-16 w-16 rounded-full bg-gray-100 dark:bg-gray-800 border-2 border-white dark:border-gray-700 shadow-sm flex-shrink-0 flex items-center justify-center overflow-hidden">
                    {user.avatarUrl ? (
                      <img
                        src={user.avatarUrl}
                        alt={user.username}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-xl font-bold text-gray-400 uppercase">
                        {user.username?.charAt(0)}
                      </span>
                    )}
                  </div>

                  {/* Basic info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-lg font-bold text-gray-900 dark:text-white truncate">
                      {user.fullName || 'Unknown Name'}
                    </p>
                    <p className="text-sm text-gray-500 truncate">@{user.username}</p>
                  </div>
                </div>

                {/* Detail info */}
                <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Rank:</span>
                    <span className="font-medium text-gray-700 dark:text-gray-300">
                      {user.rank?.desc || 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Section:</span>
                    <span className="px-2 py-0.5 bg-blue-50 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded text-xs font-semibold uppercase">
                      {user.section || 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Role:</span>
                    <span className="text-gray-700 dark:text-gray-300 italic">
                      {user.role || 'Member'}
                    </span>
                  </div>
                </div>

                {/* Action button */}
                <button className="mt-5 w-full py-2 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 text-sm font-medium rounded-lg transition-colors border border-gray-200 dark:border-gray-700">
                  View Profile
                </button>
              </div>
            </div>
          ))
        )}
      </div>

    </div>
  );
}