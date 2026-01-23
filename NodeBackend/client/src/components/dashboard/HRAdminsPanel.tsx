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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UserPlus, MessageSquare, Calendar, Trash2, Pause, Play, Settings, Building2, User, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Schema for registering HR Admin
const registerHRAdminSchema = z.object({
  phoneNumber: z.string().min(10, "Phone number must be at least 10 digits"),
  name: z.string().optional(),
  organizationId: z.string().min(1, "Organization ID is required"),
  userId: z.string().min(1, "User ID is required"),
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
        ragAccessKey: "", // Don't prefill masked value
        supabaseUrl: configData.config.supabaseUrl || "",
        supabaseServiceKey: "", // Don't prefill masked value
        contextMessageCount: configData.config.contextMessageCount || 5,
        isActive: configData.config.isActive === "true",
      });
    }
  }, [configData, configForm]);

  // Mutation to register HR admin
  const registerAdminMutation = useMutation({
    mutationFn: async (data: RegisterHRAdminFormData) => {
      const response = await fetch("/api/hr-admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to register HR admin");
      }

      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Success",
        description: "HR Admin registered successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/hr-admins"] });
      adminForm.reset();
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
      const response = await fetch(`/api/hr-admins/${encodeURIComponent(phoneNumber)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete HR admin");
      }

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
      const response = await fetch(`/api/hr-admins/${encodeURIComponent(phoneNumber)}/chatbot-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to toggle chatbot status");
      }

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
      const response = await fetch("/api/hr-chatbot/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update config");
      }

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
      const response = await fetch("/api/hr-chatbot/test", {
        method: "POST",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || error.message || "Test failed");
      }

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

  const onSubmitAdmin = (data: RegisterHRAdminFormData) => {
    registerAdminMutation.mutate(data);
  };

  const onSubmitConfig = (data: HRChatbotConfigFormData) => {
    updateConfigMutation.mutate(data);
  };

  const formatTimestamp = (timestamp: string | null) => {
    if (!timestamp) return "Never";
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">HR / Task Management</h2>
          <p className="text-muted-foreground">
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
            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <UserPlus className="mr-2 h-4 w-4" />
                  Register HR Admin
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Register HR Admin</DialogTitle>
                  <DialogDescription>
                    Link a WhatsApp number to a Task Management user. They can then manage tasks via WhatsApp.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={adminForm.handleSubmit(onSubmitAdmin)} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="phoneNumber">WhatsApp Phone Number *</Label>
                    <Input
                      id="phoneNumber"
                      placeholder="919876543210"
                      {...adminForm.register("phoneNumber")}
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
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="organizationId">Organization ID *</Label>
                    <Input
                      id="organizationId"
                      placeholder="uuid from supabase organizations table"
                      {...adminForm.register("organizationId")}
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
                    />
                  </div>

                  <Button type="submit" disabled={registerAdminMutation.isPending}>
                    {registerAdminMutation.isPending ? "Registering..." : "Register Admin"}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Registered HR Admins</CardTitle>
              <CardDescription>
                {hrAdmins.length} admin(s) linked to Task Management
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoadingAdmins ? (
                <p className="text-center py-4 text-muted-foreground">Loading...</p>
              ) : hrAdmins.length === 0 ? (
                <p className="text-center py-8 text-muted-foreground">
                  No HR admins registered yet. Click "Register HR Admin" to add one.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Phone</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Organization</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last Updated</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {hrAdmins.map((admin: any) => (
                      <TableRow key={admin.id}>
                        <TableCell className="font-mono">
                          {admin.phoneNumber}
                        </TableCell>
                        <TableCell>
                          {admin.name || <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Building2 className="h-4 w-4 text-muted-foreground" />
                            {admin.organizationName || admin.organizationId?.substring(0, 8) + "..."}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={admin.chatbotActive === "true" ? "default" : "secondary"}>
                            {admin.chatbotActive === "true" ? "Active" : "Paused"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {formatTimestamp(admin.updatedAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleChatbotMutation.mutate({
                                phoneNumber: admin.phoneNumber,
                                active: admin.chatbotActive !== "true"
                              })}
                              title={admin.chatbotActive === "true" ? "Pause chatbot" : "Resume chatbot"}
                            >
                              {admin.chatbotActive === "true" ? (
                                <Pause className="h-4 w-4" />
                              ) : (
                                <Play className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                if (confirm(`Remove HR admin ${admin.phoneNumber}?`)) {
                                  deleteAdminMutation.mutate(admin.phoneNumber);
                                }
                              }}
                              title="Remove admin"
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Config Tab */}
        <TabsContent value="config" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>HR Chatbot Configuration</CardTitle>
              <CardDescription>
                Configure the AI agent and Supabase connection for HR/Task Management
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={configForm.handleSubmit(onSubmitConfig)} className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="agentName">Agent Name</Label>
                    <Input
                      id="agentName"
                      placeholder="HR Task Assistant"
                      {...configForm.register("agentName")}
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
                    />
                    <p className="text-xs text-muted-foreground">
                      Number of previous messages to include in context
                    </p>
                  </div>
                </div>

                <div className="space-y-4 border-t pt-4">
                  <h3 className="font-medium">DigitalOcean AI Agent</h3>
                  
                  <div className="space-y-2">
                    <Label htmlFor="ragBaseUrl">RAG Base URL</Label>
                    <Input
                      id="ragBaseUrl"
                      placeholder="https://your-agent.agents.do-ai.run"
                      {...configForm.register("ragBaseUrl")}
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

                <div className="space-y-4 border-t pt-4">
                  <h3 className="font-medium">Task Management Supabase</h3>
                  
                  <div className="space-y-2">
                    <Label htmlFor="supabaseUrl">Supabase URL</Label>
                    <Input
                      id="supabaseUrl"
                      placeholder="https://your-project.supabase.co"
                      {...configForm.register("supabaseUrl")}
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

                <div className="flex items-center gap-4 pt-4 border-t">
                  <Button type="submit" disabled={updateConfigMutation.isPending}>
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Integration Info</CardTitle>
              <CardDescription>
                How the HR chatbot works with Task Management
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="p-4 border rounded-lg">
                  <h4 className="font-medium mb-2">📋 Create Tasks</h4>
                  <p className="text-sm text-muted-foreground">
                    "Create a task: Review reports"<br />
                    "Remind Priyanka to submit attendance"
                  </p>
                </div>
                <div className="p-4 border rounded-lg">
                  <h4 className="font-medium mb-2">📊 Check Attendance</h4>
                  <p className="text-sm text-muted-foreground">
                    "Show today's attendance"<br />
                    "Who is absent today?"
                  </p>
                </div>
                <div className="p-4 border rounded-lg">
                  <h4 className="font-medium mb-2">👥 Search Users</h4>
                  <p className="text-sm text-muted-foreground">
                    "Find employee Rahul"<br />
                    "List all admins"
                  </p>
                </div>
              </div>

              <div className="bg-muted p-4 rounded-lg">
                <h4 className="font-medium mb-2">Edge Functions Used</h4>
                <ul className="text-sm space-y-1">
                  <li>• <code className="bg-background px-1 rounded">whatsapp-create-task</code> - Create tasks</li>
                  <li>• <code className="bg-background px-1 rounded">whatsapp-get-attendance</code> - Get attendance reports</li>
                  <li>• <code className="bg-background px-1 rounded">whatsapp-get-users</code> - Search/list users</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
