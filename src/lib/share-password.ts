// Minimum length for a project's share password. Deliberately low: the share
// link already carries a random slug suffix, and failed attempts are locked
// out per IP + token, so the password is a light gate rather than a vault key.
// Shared by the create/update API schemas and the admin requirements checklist.
export const SHARE_PASSWORD_MIN_LENGTH = 4
