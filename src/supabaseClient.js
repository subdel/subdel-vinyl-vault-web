import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qofxzvvsoouqnwmrcdax.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvZnh6dnZzb291cW53bXJjZGF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMjI0ODEsImV4cCI6MjA5OTU5ODQ4MX0.yq2ICUc3VITT2bdDQLYSMvCfNexn4uSl2Ma4TOuwZFM";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 5 } },
});
