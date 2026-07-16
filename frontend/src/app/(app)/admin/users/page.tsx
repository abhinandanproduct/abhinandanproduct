'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, Pencil, Plus, Search, Trash2, UserPlus, Users as UsersIcon } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';
import { Dialog } from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { formatDate } from '@/lib/utils';

// Same module-level filter cache pattern as the Items / Vendors / Activity
// pages — survives in-app navigation, resets on hard reload.
let cachedUsersFilter: { search: string; role: string; status: string } = { search: '', role: '', status: '' };

const ROLE_OPTIONS = ['ADMIN', 'MANAGER', 'STAFF'] as const;
const STATUS_OPTIONS = ['ACTIVE', 'INACTIVE'] as const;

const roleBadgeClass: Record<string, string> = {
  ADMIN: 'bg-destructive/15 text-destructive ring-red-200',
  MANAGER: 'bg-indigo-100 text-indigo-700 ring-indigo-200',
  STAFF: 'bg-secondary/50 text-text-muted ring-slate-200',
};

/**
 * /admin/users — ADMIN-only user management.
 *
 * Operator can: create users, edit fullName / email / role / status,
 * reset password (sets a new one — no email reset link in v1), delete.
 * Last-active-admin protection is on the BACKEND so the UI doesn't have
 * to know the rule; errors surface as toasts.
 */
export default function UsersAdminPage() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [search, setSearch] = React.useState(() => cachedUsersFilter.search);
  const [role, setRole] = React.useState(() => cachedUsersFilter.role);
  const [status, setStatus] = React.useState(() => cachedUsersFilter.status);
  React.useEffect(() => { cachedUsersFilter = { search, role, status }; }, [search, role, status]);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editUser, setEditUser] = React.useState<any | null>(null);
  const [resetUser, setResetUser] = React.useState<any | null>(null);

  const usersQ = useQuery({
    queryKey: ['users', { search, role, status }],
    queryFn: () => Api.users.list({
      search: search.trim() || undefined,
      role: role || undefined,
      status: status || undefined,
    }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => Api.users.remove(id),
    onSuccess: () => {
      toast.success('User deleted.');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Manage who can sign in to the ERP. Admins can do everything; managers and staff get the operational pages."
        actions={<Button onClick={() => setCreateOpen(true)}><UserPlus className="size-4" /> Add User</Button>}
      />

      <Card className="mb-4">
        <CardContent className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-12">
          <div className="relative sm:col-span-6">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search username / name / email…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="sm:col-span-3">
            <Select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">All roles</option>
              {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </div>
          <div className="sm:col-span-3">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {usersQ.isLoading ? (
            <div className="flex items-center justify-center p-8 text-sm text-muted-foreground"><Spinner /> Loading users…</div>
          ) : (usersQ.data ?? []).length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <UsersIcon className="mx-auto mb-2 size-8 opacity-30" />
              No users match the filter.
            </div>
          ) : (
            <div className="table-scroll">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-semibold">User</th>
                    <th className="px-4 py-2 font-semibold">Email</th>
                    <th className="px-4 py-2 font-semibold">Role</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2 font-semibold">Last login</th>
                    <th className="px-4 py-2 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(usersQ.data ?? []).map((u: any) => (
                    <tr key={u.id} className="border-t border-border align-middle hover:bg-muted/30">
                      <td className="px-4 py-2">
                        <div className="font-semibold text-foreground">{u.fullName || '—'}</div>
                        <div className="text-xs text-muted-foreground">@{u.username}</div>
                      </td>
                      <td className="px-4 py-2 text-foreground">{u.email}</td>
                      <td className="px-4 py-2">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${roleBadgeClass[u.role] ?? 'bg-secondary/50 text-text-muted ring-slate-200'}`}>{u.role}</span>
                      </td>
                      <td className="px-4 py-2">
                        {u.status === 'ACTIVE'
                          ? <Badge variant="default" className="bg-success/15 text-success hover:bg-success/15">Active</Badge>
                          : <Badge variant="secondary">Inactive</Badge>}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{u.lastLoginAt ? formatDate(u.lastLoginAt) : '—'}</td>
                      <td className="px-4 py-2">
                        <div className="flex justify-end gap-1">
                          <Button variant="outline" size="icon" title="Edit" onClick={() => setEditUser(u)}>
                            <Pencil className="size-4" />
                          </Button>
                          <Button variant="outline" size="icon" title="Reset password" onClick={() => setResetUser(u)}>
                            <KeyRound className="size-4" />
                          </Button>
                          <Button
                            variant="outline" size="icon"
                            className="text-destructive hover:bg-destructive/10"
                            title="Delete"
                            onClick={() => confirm({
                              title: 'Delete user?',
                              message: `This permanently removes @${u.username} (${u.fullName}). They will no longer be able to sign in.`,
                              onConfirm: async () => { await remove.mutateAsync(u.id); },
                            })}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <CreateUserDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <EditUserDialog user={editUser} onClose={() => setEditUser(null)} />
      <ResetPasswordDialog user={resetUser} onClose={() => setResetUser(null)} />
      {dialog}
    </div>
  );
}

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [username, setUsername] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [role, setRole] = React.useState<'ADMIN' | 'MANAGER' | 'STAFF'>('STAFF');

  React.useEffect(() => {
    if (open) { setUsername(''); setEmail(''); setFullName(''); setPassword(''); setRole('STAFF'); }
  }, [open]);

  const create = useMutation({
    mutationFn: () => Api.users.create({ username, email, fullName, password, role }),
    onSuccess: () => {
      toast.success(`User @${username} created.`);
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const canSubmit = username.trim().length >= 2 && email.trim().length > 3 && fullName.trim().length >= 2 && password.length >= 6;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="Add user"
      description="Create a new account. They sign in with the username and password you set here; password can be changed later via the Reset action."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!canSubmit || create.isPending}>
            {create.isPending && <Spinner />} <Plus className="size-4" /> Create
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Full name"><Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Pratik Shah" /></Field>
        <Field label="Username" hint="3-letter prefix or short login id, no spaces">
          <Input value={username} onChange={(e) => setUsername(e.target.value.replace(/\s+/g, ''))} placeholder="e.g. pratik" />
        </Field>
        <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@company.com" /></Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as any)}>
            <option value="STAFF">Staff — daily production operator</option>
            <option value="MANAGER">Manager — can see and edit most things</option>
            <option value="ADMIN">Admin — full control + user management</option>
          </Select>
        </Field>
        <Field label="Initial password" hint="≥ 6 characters">
          <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="give them a temporary password" />
        </Field>
      </div>
    </Dialog>
  );
}

function EditUserDialog({ user, onClose }: { user: any | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [role, setRole] = React.useState<'ADMIN' | 'MANAGER' | 'STAFF'>('STAFF');
  const [status, setStatus] = React.useState<'ACTIVE' | 'INACTIVE'>('ACTIVE');

  React.useEffect(() => {
    if (user) {
      setEmail(user.email ?? ''); setFullName(user.fullName ?? '');
      setRole(user.role ?? 'STAFF'); setStatus(user.status ?? 'ACTIVE');
    }
  }, [user]);

  const save = useMutation({
    mutationFn: () => Api.users.update(user!.id, { email, fullName, role, status }),
    onSuccess: () => {
      toast.success(`User @${user?.username} updated.`);
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  if (!user) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={`Edit @${user.username}`}
      description="Username is locked once created. Change the password via the Reset action."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Spinner />} Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Full name"><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
        <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as any)}>
            <option value="STAFF">Staff</option>
            <option value="MANAGER">Manager</option>
            <option value="ADMIN">Admin</option>
          </Select>
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as any)}>
            <option value="ACTIVE">Active — can sign in</option>
            <option value="INACTIVE">Inactive — sign-in blocked</option>
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: any | null; onClose: () => void }) {
  const [password, setPassword] = React.useState('');
  React.useEffect(() => { if (user) setPassword(''); }, [user]);
  const reset = useMutation({
    mutationFn: () => Api.users.resetPassword(user!.id, password),
    onSuccess: () => {
      toast.success(`Password reset for @${user?.username}. Share the new password with them securely.`);
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  if (!user) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={`Reset password — @${user.username}`}
      description="Type a new password. The user will sign in with this on their next visit; share it through a secure channel."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={reset.isPending}>Cancel</Button>
          <Button onClick={() => reset.mutate()} disabled={password.length < 6 || reset.isPending}>
            {reset.isPending && <Spinner />} <KeyRound className="size-4" /> Reset
          </Button>
        </>
      }
    >
      <Field label="New password" hint="≥ 6 characters · shown in plain text so you can copy it">
        <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="new temporary password" />
      </Field>
    </Dialog>
  );
}
