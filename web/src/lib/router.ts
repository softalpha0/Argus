import { useEffect, useState } from 'react';

export type Route = { page: 'trade' } | { page: 'execution'; id: string } | { page: 'report'; id: string } | { page: 'stats' };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'x' && parts[1]) return { page: 'execution', id: parts[1] };
  if (parts[0] === 'r' && parts[1]) return { page: 'report', id: parts[1] };
  if (parts[0] === 'stats') return { page: 'stats' };
  return { page: 'trade' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseHash(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (hash: string) => {
  location.hash = hash;
};
