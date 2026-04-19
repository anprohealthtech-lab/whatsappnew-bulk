import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Users,
  Building2,
  PlusCircle,
  Trash2,
  KeyRound,
  Shield,
  ShieldCheck,
  User,
  X,
  ClipboardList,
  Stethoscope,
} from "lucide-react";

interface EnabledFeatures {
  taskManagement?: boolean;
  himsChatbot?: boolean;
}

interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  organizationId: string;
  role: string;
  enabledFeatures: EnabledFeatures | null;
  lastLoginAt: string | null;
  createdAt: string;
}

interface AdminStats {
  totalUsers: number;
  totalOrganizations: number;
  superAdmins: number;
  admins: number;
  regularUsers: number;
}

export function SuperAdminPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  // Create user form state
  const [createForm, setCreateForm] = useState({
    username: "",
    password: "",
    email: "",
    organizationId: "",
    role: "user",
  });

  // Queries
  const { data: stats } = useQuery<AdminStats>({
    queryKey: ["/api/admin/stats"],
  });

  const { data: allUsers = [], isLoading } = useQuery<AdminUser[]>({
    queryKey: ["/api/admin/users"],
  });

  // Mutations
  const createUserMutation = useMutation({
    mutationFn: async (data: typeof createForm) => {
      const res = await apiRequest("POST", "/api/admin/users", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
      setShowCreateUser(false);
      setCreateForm({ username: "", password: "", email: "", organizationId: "", role: "user" });
      toast({ title: "User created successfully" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create user", description: err.message, variant: "destructive" });
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (userId: string) => {
      await apiRequest("DELETE", `/api/admin/users/${userId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
      toast({ title: "User deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: string }) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${userId}`, { role });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
      toast({ title: "Role updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update role", description: err.message, variant: "destructive" });
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async ({ userId, newPassword }: { userId: string; newPassword: string }) => {
      await apiRequest("POST", `/api/admin/users/${userId}/reset-password`, { newPassword });
    },
    onSuccess: () => {
      setShowResetPassword(null);
      setNewPassword("");
      toast({ title: "Password reset successfully" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to reset password", description: err.message, variant: "destructive" });
    },
  });

  const toggleFeatureMutation = useMutation({
    mutationFn: async ({ userId, features }: { userId: string; features: EnabledFeatures }) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${userId}`, { enabledFeatures: features });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Feature updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update feature", description: err.message, variant: "destructive" });
    },
  });

  const roleIcon = (role: string) => {
    if (role === "super_admin") return <ShieldCheck className="w-4 h-4 text-red-500" />;
    if (role === "admin") return <Shield className="w-4 h-4 text-blue-500" />;
    return <User className="w-4 h-4 text-gray-500" />;
  };

  // Group users by org
  const orgMap = new Map<string, AdminUser[]>();
  allUsers.forEach((u) => {
    const list = orgMap.get(u.organizationId) || [];
    list.push(u);
    orgMap.set(u.organizationId, list);
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Super Admin Panel</h2>
          <p className="text-muted-foreground">Manage all organizations and users</p>
        </div>
        <Button onClick={() => setShowCreateUser(true)}>
          <PlusCircle className="w-4 h-4 mr-2" /> Add User
        </Button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="p-4 bg-card rounded-xl border">
            <p className="text-2xl font-bold">{stats.totalUsers}</p>
            <p className="text-sm text-muted-foreground">Total Users</p>
          </div>
          <div className="p-4 bg-card rounded-xl border">
            <p className="text-2xl font-bold">{stats.totalOrganizations}</p>
            <p className="text-sm text-muted-foreground">Organizations</p>
          </div>
          <div className="p-4 bg-card rounded-xl border">
            <p className="text-2xl font-bold text-red-500">{stats.superAdmins}</p>
            <p className="text-sm text-muted-foreground">Super Admins</p>
          </div>
          <div className="p-4 bg-card rounded-xl border">
            <p className="text-2xl font-bold text-blue-500">{stats.admins}</p>
            <p className="text-sm text-muted-foreground">Admins</p>
          </div>
          <div className="p-4 bg-card rounded-xl border">
            <p className="text-2xl font-bold text-gray-500">{stats.regularUsers}</p>
            <p className="text-sm text-muted-foreground">Users</p>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      {showCreateUser && (
        <div className="p-6 bg-card rounded-xl border space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-lg">Create New User</h3>
            <button onClick={() => setShowCreateUser(false)}><X className="w-5 h-5" /></button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Username *</label>
              <input
                type="text"
                className="w-full px-3 py-2 border rounded-lg"
                value={createForm.username}
                onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Password *</label>
              <input
                type="password"
                className="w-full px-3 py-2 border rounded-lg"
                value={createForm.password}
                onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                className="w-full px-3 py-2 border rounded-lg"
                value={createForm.email}
                onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Organization ID</label>
              <input
                type="text"
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="Leave empty for auto-generated"
                value={createForm.organizationId}
                onChange={(e) => setCreateForm({ ...createForm, organizationId: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Role</label>
              <select
                className="w-full px-3 py-2 border rounded-lg"
                value={createForm.role}
                onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
                <option value="super_admin">Super Admin</option>
              </select>
            </div>
          </div>
          <Button
            onClick={() => createUserMutation.mutate(createForm)}
            disabled={createUserMutation.isPending || !createForm.username || !createForm.password}
          >
            {createUserMutation.isPending ? "Creating..." : "Create User"}
          </Button>
        </div>
      )}

      {/* Users by Organization */}
      {isLoading ? (
        <p className="text-muted-foreground">Loading users...</p>
      ) : (
        <div className="space-y-6">
          {Array.from(orgMap.entries()).map(([orgId, orgUsers]) => (
            <div key={orgId} className="bg-card rounded-xl border overflow-hidden">
              <div className="px-6 py-4 bg-accent/30 border-b flex items-center gap-3">
                <Building2 className="w-5 h-5 text-primary" />
                <span className="font-semibold">{orgId}</span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {orgUsers.length} user{orgUsers.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="divide-y">
                {orgUsers.map((u: AdminUser) => (
                  <div key={u.id} className="px-6 py-3 flex items-center gap-4">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {roleIcon(u.role)}
                      <div className="min-w-0">
                        <p className="font-medium truncate">{u.username}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {u.email || "No email"} &middot; {u.role} &middot; Last login: {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : "Never"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* Feature toggles */}
                      <div className="flex items-center gap-1 mr-2">
                        <button
                          onClick={() => {
                            const current = u.enabledFeatures || {};
                            toggleFeatureMutation.mutate({
                              userId: u.id,
                              features: { ...current, taskManagement: !current.taskManagement },
                            });
                          }}
                          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                            u.enabledFeatures?.taskManagement
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                              : "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500"
                          }`}
                          title={u.enabledFeatures?.taskManagement ? "Disable Task Management" : "Enable Task Management"}
                        >
                          <ClipboardList className="w-3 h-3" />
                          Tasks
                        </button>
                        <button
                          onClick={() => {
                            const current = u.enabledFeatures || {};
                            toggleFeatureMutation.mutate({
                              userId: u.id,
                              features: { ...current, himsChatbot: !current.himsChatbot },
                            });
                          }}
                          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                            u.enabledFeatures?.himsChatbot
                              ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                              : "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500"
                          }`}
                          title={u.enabledFeatures?.himsChatbot ? "Disable OPD Bot" : "Enable OPD Bot"}
                        >
                          <Stethoscope className="w-3 h-3" />
                          OPD
                        </button>
                      </div>
                      {/* Role selector */}
                      <select
                        className="text-xs px-2 py-1 border rounded"
                        value={u.role}
                        onChange={(e) => updateRoleMutation.mutate({ userId: u.id, role: e.target.value })}
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                        <option value="super_admin">Super Admin</option>
                      </select>
                      {/* Reset password */}
                      {showResetPassword === u.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="password"
                            className="text-xs px-2 py-1 border rounded w-28"
                            placeholder="New password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => resetPasswordMutation.mutate({ userId: u.id, newPassword })}
                            disabled={resetPasswordMutation.isPending || newPassword.length < 6}
                          >
                            Save
                          </Button>
                          <button onClick={() => { setShowResetPassword(null); setNewPassword(""); }}>
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setShowResetPassword(u.id)}
                          title="Reset password"
                        >
                          <KeyRound className="w-4 h-4" />
                        </Button>
                      )}
                      {/* Delete */}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          if (confirm(`Delete user "${u.username}"? This cannot be undone.`)) {
                            deleteUserMutation.mutate(u.id);
                          }
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
