

export default function SalesDocPublicNotFound() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-10">
        <div className="rounded-xl border bg-card p-6">
          <h1 className="text-xl font-semibold">Link unavailable</h1>
          <p className="text-sm text-muted-foreground mt-2">
            This document link is incorrect, has expired, or has been revoked.
            If you need assistance, please contact us and we can provide a new link.
          </p>

        </div>
      </div>
    </div>
  )
}
