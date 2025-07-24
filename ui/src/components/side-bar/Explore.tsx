"use client";

import { GoTelescope } from "react-icons/go";

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function Explore() {
  const pathname = usePathname();
  const isActive = pathname === '/explore';

  return (
    <Link href="/explore" className="w-full">
      <div className={`w-[75%] aspect-square mx-auto mb-2 px-4 py-2 flex flex-col items-center justify-center transition-colors duration-200 rounded-xl ${
        isActive
          ? 'bg-green-50 dark:bg-green-900/10 text-green-700 dark:text-green-300'
          : 'hover:bg-green-50 dark:hover:bg-green-900/10 hover:text-green-700 dark:hover:text-green-300'
      }`}>
        <GoTelescope className="w-6.5 h-6.5" />
      </div>
    </Link>
  );
}
