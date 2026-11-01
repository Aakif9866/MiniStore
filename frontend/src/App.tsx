import { useEffect, useState } from "react";
import { getToken } from "./api";
import { Auth } from "./Auth";
import { Files } from "./Files";

export function App() {
  const [token, setTokenState] = useState(getToken);

  // api.setToken fires this on login, logout and expired sessions.
  useEffect(() => {
    const sync = () => setTokenState(getToken());
    window.addEventListener("auth-change", sync);
    return () => window.removeEventListener("auth-change", sync);
  }, []);

  return (
    <>
      <div className="h-1.5 brand-gradient" />
      {token ? <Files /> : <Auth />}
    </>
  );
}

export function Logo() {
  return (
    <span className="text-xl font-bold tracking-tight">
      <span className="brand-gradient rounded-tl-xl rounded-br-xl px-2 py-1 text-white">Mini</span>
      Store
    </span>
  );
}
