import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UserPlus, Settings, Building2, User, Pause, Play, Trash2, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

// Schema for registering HR Admin
const registerHRAdminSchema = z.object({
  phoneNumber: z.string().min(10, "Phone number must be at least 10 digits"),
  name: z.string().optional(),
  organizationId: z.string().uuid("Organization ID must be a valid UUID"),
  userId: z.string().uuid("User ID must be a valid UUID"),
  organizationName: z.string().optional(),
});

// Schema for HR Chatbot Config
const hrChatbotConfigSchema = z.object({
  agentName: z.string().min(1, "Agent name is required"),
  ragBaseUrl: z.string().url("Valid RAG base URL is required"),
  ragAccessKey: z.string().min(1, "RAG access key is required"),
  supabaseUrl: z.string().url("Valid Supabase URL is required"),
  supabaseServiceKey: z.string().min(1, "Supabase service key is required"),
  contextMessageCount: z.number().int().min(1).max(10).optional(),
  isActive: z.boolean().optional(),
});

type RegisterHRAdminFormData = z.infer<typeof registerHRAdminSchema>;
type HRChatbotConfigFormData = z.infer<typeof hrChatbotConfigSchema>;

export function HRAdminsPanel() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("admins");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [editingAdminPhone, setEditingAdminPhone] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Form for registering HR Admin
  const adminForm = useForm<RegisterHRAdminFormData>({
    resolver: zodResolver(registerHRAdminSchema),
    defaultValues: {
      phoneNumber: "",
      name: "",
      organizationId: "",
      userId: "",
      organizationName: "",
    },
  });

  // Form for HR Chatbot Config
  const configForm = useForm<HRChatbotConfigFormData>({
    resolver: zodResolver(hrChatbotConfigSchema),
    defaultValues: {
      agentName: "HR Task Assistant",
      ragBaseUrl: "",
      ragAccessKey: "",
      supabaseUrl: "",
      supabaseServiceKey: "",
      contextMessageCount: 5,
      isActive: true,
    },
  });

  // Query HR admins
  const { data: hrAdminsData, isLoading: isLoadingAdmins } = useQuery<{ hrAdmins: any[] }>({
    queryKey: ["/api/hr-admins"],
    refetchInterval: 30000,
  });

  const hrAdmins = hrAdminsData?.hrAdmins || [];

  // Query HR chatbot config
  const { data: configData, isLoading: isLoadingConfig } = useQuery<{ config: any }>({
    queryKey: ["/api/hr-chatbot/config"],
  });

  // Update form when config data changes
  useEffect(() => {
    if (configData?.config) {
      configForm.reset({
        agentName: configData.config.agentName || "HR Task Assistant",
        ragBaseUrl: configData.config.ragBaseUrl || "",
        ragAccessKey: "",
        supabaseUrl: configData.config.supabaseUrl || "",
        supabaseServiceKey: "",
        contextMessageCount: configData.config.contextMessageCount || 5,
        isActive: configData.config.isActive === "true",
      });
    }
  }, [configData, configForm]);

  // Mutation to register HR admin
  const registerAdminMutation = useMutation({
    mutationFn: async (data: RegisterHRAdminFormData) => {
      const response = await apiRequest("POST", "/api/hr-admins", data);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Success",
        description: editingAdminPhone ? "HR Admin updated successfully" : "HR Admin registered successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/hr-admins"] });
      adminForm.reset();
      setEditingAdminPhone(null);
      setIsDialogOpen(false);
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Mutation to delete HR admin
  const deleteAdminMutation = useMutation({
    mutationFn: async (phoneNumber: string) => {
      const response = await apiRequest("DELETE", `/api/hr-admins/${encodeURIComponent(phoneNumber)}`);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Success",
        description: "HR Admin removed successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/hr-admins"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Mutation to toggle chatbot status
  const toggleChatbotMutation = useMutation({
    mutationFn: async ({ phoneNumber, active }: { phoneNumber: string; active: boolean }) => {
      const response = await apiRequest("PATCH", `/api/hr-admins/${encodeURIComponent(phoneNumber)}/chatbot-status`, { active });
      return response.json();
    },
    onSuccess: (_, variables) => {
      toast({
        title: "Success",
        description: variables.active ? "HR Chatbot enabled" : "HR Chatbot paused",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/hr-admins"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Mutation to update config
  const updateConfigMutation = useMutation({
    mutationFn: async (data: HRChatbotConfigFormData) => {
      const response = await apiRequest("PUT", "/api/hr-chatbot/config", data);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Success",
        description: "HR Chatbot config updated successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/hr-chatbot/config"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Mutation to test connection
  const testConnectionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/hr-chatbot/test");
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: data.success ? "Connection Successful" : "Connection Failed",
        description: data.message,
        variant: data.success ? "default" : "destructive",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const openCreateDialog = () => {
    setEditingAdminPhone(null);
    adminForm.reset({
      phoneNumber: "",
      name: "",
      organizationId: "",
      userId: "",
      organizationName: "",
    });
    setIsDialogOpen(true);
  };

  const openEditDialog = (admin: any) => {
    setEditingAdminPhone(admin.phoneNumber);
    adminForm.reset({
      phoneNumber: admin.phoneNumber || "",
      name: admin.name || "",
      organizationId: admin.organizationId || "",
      userId: admin.userId || "",
      organizationName: admin.organizationName || "",
    });
    setIsDialogOpen(true);
  };

  const onSubmitAdmin = (data: RegisterHRAdminFormData) => {
    registerAdminMutation.mutate({
      ...data,
      phoneNumber: data.phoneNumber.trim(),
      name: data.name?.trim(),
      organizationId: data.organizationId.trim(),
      userId: data.userId.trim(),
      organizationName: data.organizationName?.trim(),
    });
  };

  const onSubmitConfig = (data: HRChatbotConfigFormData) => {
    updateConfigMutation.mutate(data);
  };

  const formatTimestamp = (timestamp: string | null) => {
    if (!timestamp) return "Never";
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">HR / Task Management</h2>
          <p className="text-muted-foreground text-sm">
            Manage HR admins who can interact with Task Management via WhatsApp
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="admins">
            <User className="mr-2 h-4 w-4" />
            HR Admins
          </TabsTrigger>
          <TabsTrigger value="config">
            <Settings className="mr-2 h-4 w-4" />
            Chatbot Config
          </TabsTrigger>
        </TabsList>

        {/* HR Admins Tab */}
        <TabsContent value="admins" className="space-y-4">
          <div className="flex justify-end">
            <Dialog open={isDialogOpen} onOpenChange={(open) => {
              setIsDialogOpen(open);
              if (!open) setEditingAdminPhone(null);
            }}>
              <DialogTrigger asChild>
                <Button
                  className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20"
                  onClick={openCreateDialog}
                >
                  <UserPlus className="mr-2 h-4 w-4" />
                  Register HR Admin
                </Button>
              </DialogTrigger>
              <DialogContent className="border-none shadow-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl">
                <DialogHeader>
                  <DialogTitle>{editingAdminPhone ? "Edit HR Admin" : "Register HR Admin"}</DialogTitle>
                  <DialogDescription>
                    Link a WhatsApp number to a Task Management user. The organization ID is used for all HRMS tool calls.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={adminForm.handleSubmit(onSubmitAdmin)} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="phoneNumber">WhatsApp Phone Number *</Label>
                    <Input
                      id="phoneNumber"
                      placeholder="919876543210"
                      {...adminForm.register("phoneNumber")}
                      readOnly={!!editingAdminPhone}
                      className={`${editingAdminPhone ? "bg-muted" : "bg-white dark:bg-zinc-950"} border-gray-200 dark:border-zinc-800 focus:ring-primary`}
                    />
                    {adminForm.formState.errors.phoneNumber && (
                      <p className="text-sm text-destructive">
                        {adminForm.formState.errors.phoneNumber.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="name">Admin Name (Optional)</Label>
                    <Input
                      id="name"
                      placeholder="John Doe"
                      {...adminForm.register("name")}
                      className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="organizationId">Organization ID *</Label>
                    <Input
                      id="organizationId"
                      placeholder="uuid from supabase organizations table"
                      {...adminForm.register("organizationId")}
                      className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                    />
                    {adminForm.formState.errors.organizationId && (
                      <p className="text-sm text-destructive">
                        {adminForm.formState.errors.organizationId.message}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      UUID from the Task Management Supabase organizations table
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="userId">User ID *</Label>
                    <Input
                      id="userId"
                      placeholder="uuid from supabase users table"
                      {...adminForm.register("userId")}
                      className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                    />
                    {adminForm.formState.errors.userId && (
                      <p className="text-sm text-destructive">
                        {adminForm.formState.errors.userId.message}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      UUID from the Task Management Supabase users table
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="organizationName">Organization Name (Optional)</Label>
                    <Input
                      id="organizationName"
                      placeholder="Acme Corp"
                      {...adminForm.register("organizationName")}
                      className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                    />
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setIsDialogOpen(false);
                        setEditingAdminPhone(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={registerAdminMutation.isPending}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-md shadow-primary/20"
                    >
                      {registerAdminMutation.isPending
                        ? editingAdminPhone ? "Updating..." : "Registering..."
                        : editingAdminPhone ? "Update Admin" : "Register Admin"}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-lg font-semibold">Registered HR Admins</CardTitle>
              <CardDescription>
                {hrAdmins.length} admin(s) linked to Task Management
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoadingAdmins ? (
                <div className="space-y-4">
                  {[...Array(2)].map((_, i) => (
                    <div key={i} className="flex items-center space-x-4 p-4">
                      <Skeleton className="h-5 w-32" />
                      <Skeleton className="h-5 w-24" />
                      <Skeleton className="h-5 w-28" />
                      <Skeleton className="h-6 w-16 rounded-full" />
                      <Skeleton className="h-5 w-24" />
                      <Skeleton className="h-8 w-20" />
                    </div>
                  ))}
                </div>
              ) : hrAdmins.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center bg-accent/20 rounded-xl border border-dashed border-border">
                  <UserPlus className="h-12 w-12 text-muted-foreground/50 mb-4" />
                  <p className="text-lg font-medium">No HR admins registered yet</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Click "Register HR Admin" to add one
                  </p>
                </div>
              ) : (
                <div className="overflow-auto rounded-xl border border-gray-200 dark:border-zinc-800">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-gray-50 dark:bg-zinc-900/50 hover:bg-gray-50 dark:hover:bg-zinc-900/50">
                        <TableHead className="font-medium text-muted-foreground">Phone</TableHead>
                        <TableHead className="font-medium text-muted-foreground">Name</TableHead>
                        <TableHead className="font-medium text-muted-foreground">Organization</TableHead>
                        <TableHead className="font-medium text-muted-foreground">Status</TableHead>
                        <TableHead className="font-medium text-muted-foreground">Last Updated</TableHead>
                        <TableHead className="text-right font-medium text-muted-foreground">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {hrAdmins.map((admin: any) => (
                        <TableRow key={admin.id} className="hover:bg-gray-50 dark:hover:bg-zinc-900/50 transition-colors">
                          <TableCell className="font-mono text-foreground">
                            {admin.phoneNumber}
                          </TableCell>
                          <TableCell className="text-foreground">
                            {admin.name || <span className="text-muted-foreground">--</span>}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Building2 className="h-4 w-4 text-muted-foreground" />
                              <div className="min-w-0">
                                <div className="text-foreground">{admin.organizationName || "Task Management org"}</div>
                                <div className="font-mono text-xs text-muted-foreground break-all">{admin.organizationId}</div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            {admin.chatbotActive === "true" ? (
                              <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-200">
                                Active
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="border-yellow-500/50 text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20">
                                Paused
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {formatTimestamp(admin.updatedAt)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => toggleChatbotMutation.mutate({
                                  phoneNumber: admin.phoneNumber,
                                  active: admin.chatbotActive !== "true"
                                })}
                                title={admin.chatbotActive === "true" ? "Pause chatbot" : "Resume chatbot"}
                                className="hover:bg-accent"
                              >
                                {admin.chatbotActive === "true" ? (
                                  <Pause className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                                ) : (
                                  <Play className="h-4 w-4 text-green-600 dark:text-green-400" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openEditDialog(admin)}
                                title="Edit HR org/user IDs"
                                className="hover:bg-accent"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setDeleteTarget(admin.phoneNumber)}
                                title="Remove admin"
                                className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Config Tab */}
        <TabsContent value="config" className="space-y-4">
          <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-lg font-semibold">HR Chatbot Configuration</CardTitle>
              <CardDescription>
                Configure the AI agent and Supabase connection for HR/Task Management
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoadingConfig ? (
                <div className="space-y-6">
                  <div className="grid gap-4 md:grid-cols-2">
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                  </div>
                  <Skeleton className="h-32 w-full" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : (
                <form onSubmit={configForm.handleSubmit(onSubmitConfig)} className="space-y-6">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="agentName">Agent Name</Label>
                      <Input
                        id="agentName"
                        placeholder="HR Task Assistant"
                        {...configForm.register("agentName")}
                        className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                      />
                      {configForm.formState.errors.agentName && (
                        <p className="text-sm text-destructive">
                          {configForm.formState.errors.agentName.message}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="contextMessageCount">Context Messages</Label>
                      <Input
                        id="contextMessageCount"
                        type="number"
                        min="1"
                        max="10"
                        {...configForm.register("contextMessageCount", { valueAsNumber: true })}
                        className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                      />
                      <p className="text-xs text-muted-foreground">
                        Number of previous messages to include in context
                      </p>
                    </div>
                  </div>

                  <div className="space-y-4 border-t border-border/50 pt-4">
                    <h3 className="font-medium text-foreground">DigitalOcean AI Agent</h3>

                    <div className="space-y-2">
                      <Label htmlFor="ragBaseUrl">RAG Base URL</Label>
                      <Input
                        id="ragBaseUrl"
                        placeholder="https://your-agent.agents.do-ai.run"
                        {...configForm.register("ragBaseUrl")}
                        className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                      />
                      {configForm.formState.errors.ragBaseUrl && (
                        <p className="text-sm text-destructive">
                          {configForm.formState.errors.ragBaseUrl.message}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="ragAccessKey">RAG Access Key</Label>
                      <Input
                        id="ragAccessKey"
                        type="password"
                        placeholder="Enter access key"
                        {...configForm.register("ragAccessKey")}
                        className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                      />
                      {configForm.formState.errors.ragAccessKey && (
                        <p className="text-sm text-destructive">
                          {configForm.formState.errors.ragAccessKey.message}
                        </p>
                      )}
                      {configData?.config?.ragAccessKey && (
                        <p className="text-xs text-muted-foreground">
                          Current: {configData.config.ragAccessKey}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="space-y-4 border-t border-border/50 pt-4">
                    <h3 className="font-medium text-foreground">Task Management Supabase</h3>

                    <div className="space-y-2">
                      <Label htmlFor="supabaseUrl">Supabase URL</Label>
                      <Input
                        id="supabaseUrl"
                        placeholder="https://your-project.supabase.co"
                        {...configForm.register("supabaseUrl")}
                        className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                      />
                      {configForm.formState.errors.supabaseUrl && (
                        <p className="text-sm text-destructive">
                          {configForm.formState.errors.supabaseUrl.message}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="supabaseServiceKey">Supabase Service Role Key</Label>
                      <Input
                        id="supabaseServiceKey"
                        type="password"
                        placeholder="Enter service role key"
                        {...configForm.register("supabaseServiceKey")}
                        className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                      />
                      {configForm.formState.errors.supabaseServiceKey && (
                        <p className="text-sm text-destructive">
                          {configForm.formState.errors.supabaseServiceKey.message}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        This key is used to call Task Management edge functions
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 pt-4 border-t border-border/50">
                    <Button
                      type="submit"
                      disabled={updateConfigMutation.isPending}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-md shadow-primary/20"
                    >
                      {updateConfigMutation.isPending ? "Saving..." : "Save Configuration"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => testConnectionMutation.mutate()}
                      disabled={testConnectionMutation.isPending}
                    >
                      {testConnectionMutation.isPending ? "Testing..." : "Test Connection"}
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>

          <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-lg font-semibold">Integration Info</CardTitle>
              <CardDescription>
                How the HR chatbot works with Task Management
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="p-4 border border-gray-200 dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-950 hover:shadow-md transition-all duration-300">
                  <h4 className="font-medium mb-2 text-foreground">Create Tasks</h4>
                  <p className="text-sm text-muted-foreground">
                    "Create a task: Review reports"<br />
                    "Remind Priyanka to submit attendance"
                  </p>
                </div>
                <div className="p-4 border border-gray-200 dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-950 hover:shadow-md transition-all duration-300">
                  <h4 className="font-medium mb-2 text-foreground">Check Attendance</h4>
                  <p className="text-sm text-muted-foreground">
                    "Show today's attendance"<br />
                    "Who is absent today?"
                  </p>
                </div>
                <div className="p-4 border border-gray-200 dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-950 hover:shadow-md transition-all duration-300">
                  <h4 className="font-medium mb-2 text-foreground">Search Users</h4>
                  <p className="text-sm text-muted-foreground">
                    "Find employee Rahul"<br />
                    "List all admins"
                  </p>
                </div>
              </div>

              <div className="bg-muted/50 p-4 rounded-xl border border-border">
                <h4 className="font-medium mb-2 text-foreground">Edge Functions Used</h4>
                <ul className="text-sm space-y-1 text-muted-foreground">
                  <li><code className="bg-background px-2 py-0.5 rounded text-xs font-mono">whatsapp-create-task</code> - Create tasks</li>
                  <li><code className="bg-background px-2 py-0.5 rounded text-xs font-mono">whatsapp-get-attendance</code> - Get attendance reports</li>
                  <li><code className="bg-background px-2 py-0.5 rounded text-xs font-mono">whatsapp-get-users</code> - Search/list users</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="border-none shadow-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove HR Admin</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove <span className="font-mono font-semibold">{deleteTarget}</span> from HR admins? They will no longer be able to manage tasks via WhatsApp.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) {
                  deleteAdminMutation.mutate(deleteTarget);
                  setDeleteTarget(null);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove Admin
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
