# CRM Dashboard V1 Release Polish

## Dashboard index ownership

CRM Dashboard V1 indexes are owned by the Prisma migration:

- `prisma/migrations/20260712000000_dashboard_indexes/migration.sql`

The matching Prisma schema declarations live on `Deal`, `Activity`, and `Conversation` in:

- `prisma/schema.prisma`

The setup SQL files under `prisma/sql/` remain for one-time extension, RLS, storage, and non-Prisma helper setup. Dashboard indexes must not be duplicated there; migration history is the deployable source of truth for these indexes.

## Indexes added

- `deals_organization_id_closed_at_idx`
- `deals_organization_id_pipeline_id_closed_at_idx`
- `activities_organization_id_type_due_at_idx`
- `activities_organization_id_type_created_at_idx`
- `conversations_organization_id_updated_at_idx`
