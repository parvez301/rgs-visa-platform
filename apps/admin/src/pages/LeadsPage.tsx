import { useQuery } from "@tanstack/react-query";
import { AdminShell } from "../components/AdminShell";
import { adminApi } from "../lib/adminApi";
import { useAuth } from "../lib/auth";

function formatTime(isoTimestamp: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(isoTimestamp));
}

export function LeadsPage() {
  const { idToken } = useAuth();
  const leadsQuery = useQuery({
    queryKey: ["admin-leads"],
    queryFn: () => adminApi.listLeads(idToken!),
    enabled: idToken !== null,
  });

  const leads = leadsQuery.data ?? [];

  return (
    <AdminShell>
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Leads</h1>
        <p className="mt-1 text-ink-soft">Website enquiries awaiting follow-up.</p>
      </div>

      {leadsQuery.isLoading ? (
        <p className="text-ink-soft">Loading leads…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-paper">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-mist text-ink-soft">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Topic</th>
                <th className="px-4 py-3 font-medium">Message</th>
                <th className="px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.leadId} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 font-medium">{lead.fullName}</td>
                  <td className="px-4 py-3">{lead.phone}</td>
                  <td className="px-4 py-3">{lead.topic}</td>
                  <td className="px-4 py-3 max-w-xs truncate text-ink-soft">
                    {lead.message || "—"}
                  </td>
                  <td className="px-4 py-3 text-ink-soft whitespace-nowrap">
                    {formatTime(lead.createdAt)}
                  </td>
                </tr>
              ))}
              {leads.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-ink-soft">
                    No new leads.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
