import { useEffect, useState } from "react";
export function useRoute() {
  const [route, setRoute] = useState(location.hash.slice(1) || "/library");
  useEffect(() => {
    const update = () => {
      setRoute(location.hash.slice(1) || "/library");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
