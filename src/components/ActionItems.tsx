'use client';

import { useState } from 'react';

interface Props {
  items: string[];
}

export default function ActionItems({ items }: Props) {
  const [checked, setChecked] = useState<Set<number>>(new Set());

  if (!items.length) {
    return (
      <p className="text-xs text-gray-500 italic px-1">
        No action items detected yet.
      </p>
    );
  }

  const toggle = (i: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li
          key={i}
          onClick={() => toggle(i)}
          className="flex items-start gap-2 cursor-pointer group"
        >
          <span
            className={`mt-0.5 w-4 h-4 flex-shrink-0 rounded border text-xs flex items-center justify-center transition-colors ${
              checked.has(i)
                ? 'bg-indigo-500 border-indigo-500 text-white'
                : 'border-gray-600 group-hover:border-indigo-400'
            }`}
          >
            {checked.has(i) && '✓'}
          </span>
          <span
            className={`text-xs leading-snug transition-colors ${
              checked.has(i) ? 'line-through text-gray-500' : 'text-gray-300'
            }`}
          >
            {item}
          </span>
        </li>
      ))}
    </ul>
  );
}
