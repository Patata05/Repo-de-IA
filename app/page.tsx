import { readInventario } from "@/lib/supabase";
import InventoryView from "./inventory-view";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { rows } = await readInventario();
  return <InventoryView rows={rows} />;
}
