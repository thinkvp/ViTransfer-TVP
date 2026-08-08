// Project-scoping helper for schedule API routes: 404s when the project does
// not exist, its status is hidden from the user's role, or the user is not
// assigned to it (non-system-admins). Same semantics as the key-dates routes.
//
// The implementation is shared with other internal single-project routes (the AI
// assistant's add-to-existing-project mode), so it lives in src/lib/project-access.ts;
// this re-export keeps the existing `@/lib/gantt/access` import path working.

export { assertProjectAccessOr404 } from '@/lib/project-access'
