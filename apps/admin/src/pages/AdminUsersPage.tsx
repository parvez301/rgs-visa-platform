import { ADMIN_ROLES, type AdminRole } from "@rgs/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { AdminShell } from "../components/AdminShell";
import { adminApi } from "../lib/adminApi";
import { useAuth } from "../lib/auth";

const STAFF_QUERY_KEY = ["admin-staff"] as const;
const INPUT_CLASS =
  "rounded-xl border border-line bg-paper px-3 py-2 text-sm focus:border-ink/30";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Staff update failed";
}

export function AdminUsersPage() {
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AdminRole>("Ops");
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const staffQuery = useQuery({
    queryKey: STAFF_QUERY_KEY,
    queryFn: () => adminApi.listStaff(idToken!),
    enabled: idToken !== null,
  });

  function refreshStaff(): void {
    void queryClient.invalidateQueries({ queryKey: STAFF_QUERY_KEY });
  }

  function beginAction(): void {
    setActionError(null);
    setSuccessMessage(null);
  }

  const inviteMutation = useMutation({
    mutationFn: (input: { email: string; role: AdminRole }) =>
      adminApi.inviteStaff(idToken!, input),
    onMutate: beginAction,
    onSuccess: (staffMember) => {
      setInviteEmail("");
      setSuccessMessage(`Invited ${staffMember.email}`);
      refreshStaff();
    },
    onError: (error) => setActionError(errorMessage(error)),
  });

  const roleMutation = useMutation({
    mutationFn: ({ username, role }: { username: string; role: AdminRole }) =>
      adminApi.setStaffRole(idToken!, username, role),
    onMutate: beginAction,
    onSuccess: () => {
      setSuccessMessage("Role updated");
      refreshStaff();
    },
    onError: (error) => setActionError(errorMessage(error)),
  });

  const statusMutation = useMutation({
    mutationFn: ({
      username,
      enabled,
    }: {
      username: string;
      enabled: boolean;
    }) => {
      if (enabled) {
        return adminApi.enableStaff(idToken!, username).then(() => undefined);
      }
      return adminApi.disableStaff(idToken!, username).then(() => undefined);
    },
    onMutate: beginAction,
    onSuccess: (_result, variables) => {
      setSuccessMessage(variables.enabled ? "Staff account enabled" : "Staff account disabled");
      refreshStaff();
    },
    onError: (error) => setActionError(errorMessage(error)),
  });

  function submitInvite(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    inviteMutation.mutate({ email: inviteEmail.trim(), role: inviteRole });
  }

  return (
    <AdminShell>
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Admin users</h1>
        <p className="mt-1 text-ink-soft">
          Invite staff, assign one access role, and control account availability.
        </p>
      </div>

      <form
        onSubmit={submitInvite}
        className="mb-6 flex flex-wrap items-end gap-3 rounded-2xl border border-line bg-mist p-4"
      >
        <label className="min-w-64 flex-1">
          <span className="mb-1 block text-sm font-medium">Email</span>
          <input
            required
            type="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            className={`${INPUT_CLASS} w-full`}
            placeholder="staff@example.com"
          />
        </label>
        <label>
          <span className="mb-1 block text-sm font-medium">Invite role</span>
          <select
            value={inviteRole}
            onChange={(event) => setInviteRole(event.target.value as AdminRole)}
            className={INPUT_CLASS}
          >
            {ADMIN_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={inviteMutation.isPending}
          className="rounded-full bg-ink px-5 py-2 text-sm font-semibold text-paper hover:bg-ink/90 disabled:opacity-60"
        >
          {inviteMutation.isPending ? "Inviting…" : "Invite staff"}
        </button>
      </form>

      {actionError && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-rgs-red/30 bg-rgs-red/5 px-4 py-3 text-sm text-rgs-red"
        >
          {actionError}
        </p>
      )}
      {successMessage && (
        <p
          role="status"
          className="mb-4 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          {successMessage}
        </p>
      )}

      {staffQuery.isLoading ? (
        <p className="text-ink-soft">Loading staff…</p>
      ) : staffQuery.isError ? (
        <p
          role="alert"
          className="rounded-xl border border-rgs-red/30 bg-rgs-red/5 px-4 py-3 text-sm text-rgs-red"
        >
          {errorMessage(staffQuery.error)}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-paper">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-mist text-ink-soft">
              <tr>
                <th className="px-4 py-3 font-medium">Staff member</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Cognito status</th>
                <th className="px-4 py-3 font-medium">Access</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {(staffQuery.data ?? []).map((staffMember) => (
                <tr
                  key={staffMember.username}
                  className="border-b border-line last:border-0"
                >
                  <td className="px-4 py-3 font-medium">{staffMember.email}</td>
                  <td className="px-4 py-3">
                    <select
                      aria-label={`Role for ${staffMember.email}`}
                      value={staffMember.role ?? ""}
                      disabled={roleMutation.isPending}
                      onChange={(event) =>
                        roleMutation.mutate({
                          username: staffMember.username,
                          role: event.target.value as AdminRole,
                        })
                      }
                      className={INPUT_CLASS}
                    >
                      {staffMember.role === null && <option value="">No role</option>}
                      {ADMIN_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{staffMember.status}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                        staffMember.enabled
                          ? "bg-emerald-100 text-emerald-900"
                          : "bg-ink/10 text-ink-soft"
                      }`}
                    >
                      {staffMember.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      disabled={statusMutation.isPending}
                      aria-label={`${staffMember.enabled ? "Disable" : "Enable"} ${staffMember.email}`}
                      onClick={() => {
                        const nextAction = staffMember.enabled ? "Disable" : "Enable";
                        if (!window.confirm(`${nextAction} ${staffMember.email}?`)) return;
                        statusMutation.mutate({
                          username: staffMember.username,
                          enabled: !staffMember.enabled,
                        });
                      }}
                      className="font-semibold text-rgs-red hover:underline disabled:opacity-60"
                    >
                      {staffMember.enabled ? "Disable" : "Enable"}
                    </button>
                  </td>
                </tr>
              ))}
              {(staffQuery.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-ink-soft">
                    No staff accounts found.
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
