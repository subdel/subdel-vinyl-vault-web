import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qofxzvvsoouqnwmrcdax.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvZnh6dnZzb291cW53bXJjZGF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMjI0ODEsImV4cCI6MjA5OTU5ODQ4MX0.yq2ICUc3VITT2bdDQLYSMvCfNexn4uSl2Ma4TOuwZFM";

// "Remember me": when the vv-remember flag is "0", the auth session lives in
// sessionStorage (cleared when the tab closes); otherwise it lives in
// localStorage (survives browser restarts). The storage is chosen per call so
// toggling the checkbox at sign-in takes effect immediately.
function pickStore() {
  return localStorage.getItem("vv-remember") === "0" ? sessionStorage : localStorage;
}

const rememberAwareStorage = {
  getItem: (key) => pickStore().getItem(key) ?? localStorage.getItem(key) ?? sessionStorage.getItem(key),
  setItem: (key, value) => pickStore().setItem(key, value),
  removeItem: (key) => {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storage: rememberAwareStorage },
  realtime: { params: { eventsPerSecond: 5 } },
});
