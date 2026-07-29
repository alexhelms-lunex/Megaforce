import { redirect } from "next/navigation";
import { SetupNotice } from "@/components/setup-notice";
import { isSupabaseConfigured } from "@/lib/supabase/server";

export default function Home() {
  if (!isSupabaseConfigured()) return <SetupNotice />;
  redirect("/accounts");
}
