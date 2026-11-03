---
version: 1
slug: "app-inventory-view-tsx"
primary_target: "app/inventory-view.tsx"
related_targets: ["app/dashboard.css","app/layout.tsx"]
---

# Inventory surface brief

## Scope and visitor mode
Inventory web application, Operate mode. Restyle the existing inventory surface and shared application panels without changing product behavior.

## Audience and scene
People consulting office inventory on desktop or mobile. The specific user roles are not confirmed.

## Job and task
Locate office records by search, browse the available views, optionally narrow results by person or area, and scan the existing inventory table.

## Content and proof
Use only the existing Supabase-backed records and displayed inventory fields. Do not invent records, metrics, live updates, or CRUD capabilities.

## Constraints
Preserve search, navigation, grouping, chat, summary, light/dark theme preference, mobile navigation, keyboard focus, readable contrast, and horizontal table scrolling. Do not change Supabase data or schema.

## Chosen direction and memorable moment
Chosen: “Centro de operaciones nocturno,” based on the user-provided AeroStock dashboard reference. Use a dark blue-gray canvas, compact persistent sidebar, restrained solid panels, high-contrast data, and blue, teal, amber, and violet accents. First viewport: inventory title and record count, global search, four truthful summary metrics, and the inventory table. The inventory dashboard intentionally has no charts. On person and area views, keep the existing selectable group cards above the records. Visitor path: search, optionally filter by a person or area, then scan the table. Carry the same navigation, panel, table, and theme tokens through chat, notices, and mobile layouts. Do not copy metrics from the image that the schema cannot support.

## Unresolved decisions
Inventory roles and the intended behavior of the connected AI remain unconfirmed; neither is changed by this visual redesign.
