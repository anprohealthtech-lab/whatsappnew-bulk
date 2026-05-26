import { Fragment, useState } from "react";
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
  Settings2,
  FolderKanban,
  Eye,
  Mic,
} from "lucide-react";

interface EnabledFeatures {
  taskManagement?: boolean;
  himsChatbot?: boolean;
  dataManagement?: boolean;
  voiceAgent?: boolean;
  visibleTabs?: string[];
  himsClinicId?: string;
  himsTriggerKeywords?: string[];
  himsGreetingMessage?: string;
}

const TAB_OPTIONS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "sessions", label: "WhatsApp Sessions" },
  { id: "session-history", label: "Session History" },
  { id: "templates", label: "Templates" },
  { id: "schedules", label: "Schedules" },
  { id: "groups", label: "Group Scraper" },
  { id: "contacts", label: "Contacts" },
  { id: "history", label: "Message History" },
  { id: "auto-responses", label: "Auto-Responses" },
  { id: "leads", label: "Leads" },
  { id: "rag-settings", label: "AI Chatbot" },
  { id: "notifications", label: "Notifications" },
  { id: "knowledge-base", label: "Knowledge Base" },
  { id: "data-management", label: "Data Management" },
  { id: "task-management", label: "Task Management" },
  { id: "opd-bot", label: "OPD Bot" },
];

const DEFAULT_VISIBLE_TABS = [
  "dashboard",
  "sessions",
  "history",
  "contacts",
  "knowledge-base",
  "data-management",
];

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
  const [tabConfigUserId, setTabConfigUserId] = useState<string | null>(null);
  const [himsConfigUser, setHimsConfigUser] = useState<AdminUser | null>(null);
  const [himsConfigForm, setHimsConfigForm] = useState({
    himsClinicId: "",
  });

  // Create user form state
  const [createForm, setCreateForm] = useState({
    username: "",
    password: "",
    email: "",
    organizationId: "",
    role: "user",
    enabledFeatures: {
      taskManagement: false,
      himsChatbot: false,
      dataManagement: true,
      voiceAgent: false,
      visibleTabs: DEFAULT_VISIBLE_TABS,
    } as EnabledFeatures,
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
      setCreateForm({
        username: "",
        password: "",
        email: "",
        organizationId: "",
        role: "user",
        enabledFeatures: {
          taskManagement: false,
          himsChatbot: false,
          dataManagement: true,
          voiceAgent: false,
          visibleTabs: DEFAULT_VISIBLE_TABS,
        },
      });
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

  const toggleCreateTab = (tabId: string) => {
    const current = createForm.enabledFeatures.visibleTabs || [];
    const next = current.includes(tabId)
      ? current.filter((id) => id !== tabId)
      : [...current, tabId];
    setCreateForm({
      ...createForm,
      enabledFeatures: { ...createForm.enabledFeatures, visibleTabs: next },
    });
  };

  const toggleUserTab = (user: AdminUser, tabId: string) => {
    const currentFeatures = user.enabledFeatures || {};
    const currentTabs = currentFeatures.visibleTabs || TAB_OPTIONS.map((tab) => tab.id);
    const nextTabs = currentTabs.includes(tabId)
      ? currentTabs.filter((id) => id !== tabId)
      : [...currentTabs, tabId];

    toggleFeatureMutation.mutate({
      userId: user.id,
      features: { ...currentFeatures, visibleTabs: nextTabs },
    });
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
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-2">Module Access</label>
              <div className="flex flex-wrap gap-2">
                <label className="flex items-center gap-2 px-3 py-2 border rounded-lg text-sm">
                  <input
                    type="checkbox"
                    checked={!!createForm.enabledFeatures.dataManagement}
                    onChange={(e) => setCreateForm({
                      ...createForm,
                      enabledFeatures: { ...createForm.enabledFeatures, dataManagement: e.target.checked },
                    })}
                  />
                  <FolderKanban className="w-4 h-4" /> Data Management
                </label>
                <label className="flex items-center gap-2 px-3 py-2 border rounded-lg text-sm">
                  <input
                    type="checkbox"
                    checked={!!createForm.enabledFeatures.taskManagement}
                    onChange={(e) => setCreateForm({
                      ...createForm,
                      enabledFeatures: { ...createForm.enabledFeatures, taskManagement: e.target.checked },
                    })}
                  />
                  <ClipboardList className="w-4 h-4" /> Tasks
                </label>
                <label className="flex items-center gap-2 px-3 py-2 border rounded-lg text-sm">
                  <input
                    type="checkbox"
                    checked={!!createForm.enabledFeatures.himsChatbot}
                    onChange={(e) => setCreateForm({
                      ...createForm,
                      enabledFeatures: { ...createForm.enabledFeatures, himsChatbot: e.target.checked },
                    })}
                  />
                  <Stethoscope className="w-4 h-4" /> OPD Bot
                </label>
                <label className="flex items-center gap-2 px-3 py-2 border rounded-lg text-sm">
                  <input
                    type="checkbox"
                    checked={!!createForm.enabledFeatures.voiceAgent}
                    onChange={(e) => setCreateForm({
                      ...createForm,
                      enabledFeatures: { ...createForm.enabledFeatures, voiceAgent: e.target.checked },
                    })}
                  />
                  <Mic className="w-4 h-4" /> Voice Agent
                </label>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Visible Tabs</label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {TAB_OPTIONS.map((tab) => (
                  <label key={tab.id} className="flex items-center gap-2 text-xs px-2 py-1.5 border rounded">
                    <input
                      type="checkbox"
                      checked={createForm.enabledFeatures.visibleTabs?.includes(tab.id) ?? false}
                      onChange={() => toggleCreateTab(tab.id)}
                    />
                    {tab.label}
                  </label>
                ))}
              </div>
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
                  <Fragment key={u.id}>
                  <div className="px-6 py-3 flex items-center gap-4">
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
                            const currentTabs = current.visibleTabs || TAB_OPTIONS.map((tab) => tab.id);
                            toggleFeatureMutation.mutate({
                              userId: u.id,
                              features: {
                                ...current,
                                dataManagement: !current.dataManagement,
                                visibleTabs: current.dataManagement
                                  ? currentTabs.filter((id) => id !== "data-management")
                                  : Array.from(new Set([...currentTabs, "data-management"])),
                              },
                            });
                          }}
                          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                            u.enabledFeatures?.dataManagement
                              ? "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400"
                              : "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500"
                          }`}
                          title={u.enabledFeatures?.dataManagement ? "Disable Data Management" : "Enable Data Management"}
                        >
                          <FolderKanban className="w-3 h-3" />
                          Data
                        </button>
                        <button
                          onClick={() => {
                            // Open HIMS config dialog
                            const current = u.enabledFeatures || {};
                            setHimsConfigUser(u);
                            setHimsConfigForm({
                              himsClinicId: current.himsClinicId || u.organizationId || "",
                            });
                          }}
                          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                            u.enabledFeatures?.himsChatbot
                              ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                              : "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500"
                          }`}
                          title={u.enabledFeatures?.himsChatbot ? "Configure OPD Bot" : "Enable OPD Bot"}
                        >
                          <Stethoscope className="w-3 h-3" />
                          OPD
                          {u.enabledFeatures?.himsChatbot && <Settings2 className="w-3 h-3 ml-0.5" />}
                        </button>
                        <button
                          onClick={() => {
                            const current = u.enabledFeatures || {};
                            toggleFeatureMutation.mutate({
                              userId: u.id,
                              features: { ...current, voiceAgent: !current.voiceAgent },
                            });
                          }}
                          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                            u.enabledFeatures?.voiceAgent
                              ? "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400"
                              : "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500"
                          }`}
                          title={u.enabledFeatures?.voiceAgent ? "Disable Voice Agent" : "Enable Voice Agent"}
                        >
                          <Mic className="w-3 h-3" />
                          Voice
                        </button>
                        <button
                          type="button"
                          onClick={() => setTabConfigUserId(tabConfigUserId === u.id ? null : u.id)}
                          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                            tabConfigUserId === u.id
                              ? "bg-primary text-primary-foreground"
                              : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                          }`}
                          title="Choose visible tabs"
                        >
                            <Eye className="w-3 h-3" />
                            Tabs
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
                  {tabConfigUserId === u.id && (
                    <div className="px-6 pb-5 bg-accent/10">
                      <div className="ml-6 rounded-lg border bg-card p-4">
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <div>
                            <p className="font-medium text-sm">Visible tabs for {u.username}</p>
                            <p className="text-xs text-muted-foreground">Only selected tabs will appear in this user's sidebar.</p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              const current = u.enabledFeatures || {};
                              toggleFeatureMutation.mutate({
                                userId: u.id,
                                features: { ...current, visibleTabs: TAB_OPTIONS.map((tab) => tab.id) },
                              });
                            }}
                          >
                            Select All
                          </Button>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          {TAB_OPTIONS.map((tab) => {
                            const currentTabs = u.enabledFeatures?.visibleTabs || TAB_OPTIONS.map((item) => item.id);
                            return (
                              <label key={tab.id} className="flex items-center gap-2 text-xs px-2 py-1.5 border rounded">
                                <input
                                  type="checkbox"
                                  checked={currentTabs.includes(tab.id)}
                                  onChange={() => toggleUserTab(u, tab.id)}
                                />
                                {tab.label}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                  </Fragment>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* HIMS OPD Config Dialog */}
      {himsConfigUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card rounded-xl border shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-lg flex items-center gap-2">
                  <Stethoscope className="w-5 h-5" /> OPD Bot Config
                </h3>
                <p className="text-sm text-muted-foreground">{himsConfigUser.username}</p>
              </div>
              <button onClick={() => setHimsConfigUser(null)}><X className="w-5 h-5" /></button>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">HIMS Clinic ID</label>
              <input
                type="text"
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                placeholder={himsConfigUser.organizationId}
                value={himsConfigForm.himsClinicId}
                onChange={(e) => setHimsConfigForm({ ...himsConfigForm, himsClinicId: e.target.value })}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Defaults to user's org ID: {himsConfigUser.organizationId}
              </p>
            </div>

            <p className="text-xs text-muted-foreground">
              Trigger keywords, greeting message, and system prompt can be configured by the user in their OPD Bot panel.
            </p>

            <div className="flex gap-2">
              {himsConfigUser.enabledFeatures?.himsChatbot && (
                <Button
                  variant="outline"
                  className="text-destructive border-destructive/30"
                  onClick={() => {
                    const current = himsConfigUser.enabledFeatures || {};
                    toggleFeatureMutation.mutate({
                      userId: himsConfigUser.id,
                      features: { ...current, himsChatbot: false },
                    });
                    setHimsConfigUser(null);
                  }}
                >
                  Disable OPD
                </Button>
              )}
              <Button
                className="flex-1"
                onClick={() => {
                  const current = himsConfigUser.enabledFeatures || {};
                  toggleFeatureMutation.mutate({
                    userId: himsConfigUser.id,
                    features: {
                      ...current,
                      himsChatbot: true,
                      himsClinicId: himsConfigForm.himsClinicId || himsConfigUser.organizationId,
                    },
                  });
                  setHimsConfigUser(null);
                }}
              >
                {himsConfigUser.enabledFeatures?.himsChatbot ? "Save Config" : "Enable & Save"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
