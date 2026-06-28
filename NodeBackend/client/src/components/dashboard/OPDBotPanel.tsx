import { useEffect, useState } from "react";
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
import { UserPlus, Pause, Play, Trash2, Stethoscope, MessageSquare, Settings, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/AuthContext";
import { Textarea } from "@/components/ui/textarea";

const registerPatientSchema = z.object({
  phoneNumber: z.string().min(10, "Phone number must be at least 10 digits"),
  name: z.string().optional(),
  organizationId: z.string().uuid("Clinic ID must be a valid HIMS UUID"),
  greetingMessage: z.string().optional(),
});

type RegisterPatientFormData = z.infer<typeof registerPatientSchema>;

const OPD_LANGUAGE_OPTIONS = [
  "English",
  "Hindi",
  "Gujarati",
  "Marathi",
  "Bengali",
  "Tamil",
  "Telugu",
  "Kannada",
  "Malayalam",
  "Punjabi",
];
const DEFAULT_OPD_LANGUAGES = ["English", "Hindi", "Gujarati"];

export function OPDBotPanel() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [conversationPhone, setConversationPhone] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    himsTriggerKeywords: "",
    himsGreetingMessage: "",
    himsSystemPrompt: "",
    himsAllowedLanguages: DEFAULT_OPD_LANGUAGES,
  });
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: latestUser } = useQuery<any>({
    queryKey: ["/api/auth/me", "opd-user"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${localStorage.getItem("wa_auth_token")}` },
      });
      if (!res.ok) throw new Error("Failed to load user");
      return res.json();
    },
  });

  const clinicId = latestUser?.enabledFeatures?.himsClinicId || user?.enabledFeatures?.himsClinicId || "";

  const form = useForm<RegisterPatientFormData>({
    resolver: zodResolver(registerPatientSchema),
    defaultValues: { phoneNumber: "", name: "", organizationId: clinicId, greetingMessage: "" },
  });

  useEffect(() => {
    if (clinicId) form.setValue("organizationId", clinicId);
  }, [clinicId, form]);

  // Fetch HIMS patients
  const { data: patientsData, isLoading } = useQuery<{ patients: any[]; count: number }>({
    queryKey: ["/api/hims-patients", clinicId],
    queryFn: async () => {
      const url = clinicId
        ? `/api/hims-patients?organizationId=${encodeURIComponent(clinicId)}`
        : "/api/hims-patients";
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${localStorage.getItem("wa_auth_token")}` },
      });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });
  const patients = patientsData?.patients || [];

  // Fetch conversation
  const { data: conversationData } = useQuery<{ messages: any[] }>({
    queryKey: ["/api/hims-patients", conversationPhone, "conversation"],
    queryFn: async () => {
      const res = await fetch(
        `/api/hims-patients/${encodeURIComponent(conversationPhone!)}/conversation?limit=30`,
        { headers: { Authorization: `Bearer ${localStorage.getItem("wa_auth_token")}` } }
      );
      if (!res.ok) throw new Error("Failed to load conversation");
      return res.json();
    },
    enabled: !!conversationPhone,
  });

  // Register patient
  const registerMutation = useMutation({
    mutationFn: async (data: RegisterPatientFormData) => {
      const res = await fetch("/api/hims-patients", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("wa_auth_token")}`,
        },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to register");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/hims-patients"] });
      setIsDialogOpen(false);
      form.reset();
      toast({ title: "Patient registered for OPD Bot" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to register", description: err.message, variant: "destructive" });
    },
  });

  // Delete patient
  const deleteMutation = useMutation({
    mutationFn: async (phoneNumber: string) => {
      const res = await fetch(`/api/hims-patients/${encodeURIComponent(phoneNumber)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${localStorage.getItem("wa_auth_token")}` },
      });
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/hims-patients"] });
      setDeleteTarget(null);
      toast({ title: "Patient removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    },
  });

  // Toggle chatbot
  const toggleMutation = useMutation({
    mutationFn: async ({ phoneNumber, active }: { phoneNumber: string; active: boolean }) => {
      const res = await fetch(`/api/hims-patients/${encodeURIComponent(phoneNumber)}/chatbot-status`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("wa_auth_token")}`,
        },
        body: JSON.stringify({ chatbotActive: active ? "true" : "false" }),
      });
      if (!res.ok) throw new Error("Failed to toggle");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/hims-patients"] });
      toast({ title: "Chatbot status updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to toggle", description: err.message, variant: "destructive" });
    },
  });

  // OPD Settings
  const { data: opdSettings } = useQuery<{
    himsTriggerKeywords: string[];
    himsGreetingMessage: string;
    himsSystemPrompt: string;
    himsAllowedLanguages: string[];
  }>({
    queryKey: ["/api/opd-settings"],
    queryFn: async () => {
      const res = await fetch("/api/opd-settings", {
        headers: { Authorization: `Bearer ${localStorage.getItem("wa_auth_token")}` },
      });
      if (!res.ok) throw new Error("Failed to load settings");
      return res.json();
    },
  });

  const saveSettingsMutation = useMutation({
    mutationFn: async (data: { himsTriggerKeywords?: string[]; himsGreetingMessage?: string; himsSystemPrompt?: string; himsAllowedLanguages?: string[] }) => {
      const res = await fetch("/api/opd-settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("wa_auth_token")}`,
        },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/opd-settings"] });
      toast({ title: "OPD settings saved" });
      setShowSettings(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save settings", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Stethoscope className="w-6 h-6" /> OPD Bot Management
          </h2>
          <p className="text-muted-foreground">
            Register WhatsApp numbers for the HIMS appointment chatbot.
            Patients are also <strong>auto-registered</strong> when they send a trigger keyword (e.g. "appointment", "doctor").
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => {
            setShowSettings(!showSettings);
            if (!showSettings && opdSettings) {
              setSettingsForm({
                himsTriggerKeywords: (opdSettings.himsTriggerKeywords || []).join(", "),
                himsGreetingMessage: opdSettings.himsGreetingMessage || "",
                himsSystemPrompt: opdSettings.himsSystemPrompt || "",
                himsAllowedLanguages: opdSettings.himsAllowedLanguages || DEFAULT_OPD_LANGUAGES,
              });
            }
          }}>
            <Settings className="w-4 h-4 mr-2" /> Bot Settings
          </Button>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button><UserPlus className="w-4 h-4 mr-2" /> Register Patient</Button>
            </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Register Patient for OPD Bot</DialogTitle>
              <DialogDescription>
                Add a WhatsApp number to enable appointment booking via chatbot
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={form.handleSubmit((data) => registerMutation.mutate(data))} className="space-y-4">
              <div>
                <Label>Phone Number *</Label>
                <Input {...form.register("phoneNumber")} placeholder="919876543210" />
                {form.formState.errors.phoneNumber && (
                  <p className="text-xs text-destructive mt-1">{form.formState.errors.phoneNumber.message}</p>
                )}
              </div>
              <div>
                <Label>Patient Name</Label>
                <Input {...form.register("name")} placeholder="Ramesh Kumar" />
              </div>
              <div>
                <Label>Clinic ID (Organization ID) *</Label>
                <Input {...form.register("organizationId")} placeholder="clinic-uuid" readOnly={!!clinicId} className={clinicId ? "bg-muted" : ""} />
                {!clinicId && (
                  <p className="text-xs text-muted-foreground mt-1">Set in Super Admin → OPD Config to auto-fill</p>
                )}
              </div>
              <div>
                <Label>Greeting Message</Label>
                <Input {...form.register("greetingMessage")} placeholder="Welcome to our clinic!" />
              </div>
              <Button type="submit" disabled={registerMutation.isPending} className="w-full">
                {registerMutation.isPending ? "Registering..." : "Register"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {/* OPD Bot Settings */}
      {showSettings && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Settings className="w-5 h-5" /> OPD Bot Settings
            </CardTitle>
            <CardDescription>Configure trigger keywords, greeting message, and optional system prompt</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Supported Languages</Label>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-2">
                {OPD_LANGUAGE_OPTIONS.map((language) => {
                  const selected = settingsForm.himsAllowedLanguages.includes(language);
                  const disabled = !selected && settingsForm.himsAllowedLanguages.length >= 3;
                  return (
                    <label key={language} className="flex items-center gap-2 text-xs px-2 py-1.5 border rounded">
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={disabled}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...settingsForm.himsAllowedLanguages, language].slice(0, 3)
                            : settingsForm.himsAllowedLanguages.filter((item) => item !== language);
                          setSettingsForm({
                            ...settingsForm,
                            himsAllowedLanguages: next.length > 0 ? next : settingsForm.himsAllowedLanguages,
                          });
                        }}
                      />
                      {language}
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Choose 1 to 3. The bot will refuse other languages and keep phone numbers in English digits.
              </p>
            </div>
            <div>
              <Label>Trigger Keywords</Label>
              <Input
                value={settingsForm.himsTriggerKeywords}
                onChange={(e) => setSettingsForm({ ...settingsForm, himsTriggerKeywords: e.target.value })}
                placeholder="appointment, book, doctor, slot, opd"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Comma-separated. When someone sends a message with these words, they are auto-registered as an OPD patient.
              </p>
            </div>
            <div>
              <Label>Greeting Message</Label>
              <Textarea
                value={settingsForm.himsGreetingMessage}
                onChange={(e) => setSettingsForm({ ...settingsForm, himsGreetingMessage: e.target.value })}
                placeholder="Welcome to our clinic! I can help you book appointments with our doctors. Just tell me which doctor or date you prefer."
                rows={3}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Sent to the patient when they first trigger the bot.
              </p>
            </div>
            <div>
              <Label>Custom System Prompt (Optional)</Label>
              <Textarea
                value={settingsForm.himsSystemPrompt}
                onChange={(e) => setSettingsForm({ ...settingsForm, himsSystemPrompt: e.target.value })}
                placeholder="Leave empty to use default. Override to customize bot personality, clinic-specific instructions, etc."
                rows={5}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Advanced: Override the AI bot's system prompt. Leave empty for default behavior.
              </p>
            </div>
            <Button
              onClick={() => {
                const keywords = settingsForm.himsTriggerKeywords
                  .split(",")
                  .map((k) => k.trim())
                  .filter(Boolean);
                saveSettingsMutation.mutate({
                  himsTriggerKeywords: keywords.length > 0 ? keywords : undefined,
                  himsGreetingMessage: settingsForm.himsGreetingMessage || undefined,
                  himsSystemPrompt: settingsForm.himsSystemPrompt || undefined,
                  himsAllowedLanguages: settingsForm.himsAllowedLanguages,
                });
              }}
              disabled={saveSettingsMutation.isPending}
            >
              <Save className="w-4 h-4 mr-2" />
              {saveSettingsMutation.isPending ? "Saving..." : "Save Settings"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Patients</CardDescription>
            <CardTitle className="text-2xl">{patients.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Bot Active</CardDescription>
            <CardTitle className="text-2xl text-emerald-500">
              {patients.filter((p: any) => p.chatbotActive === "true").length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Bot Paused</CardDescription>
            <CardTitle className="text-2xl text-amber-500">
              {patients.filter((p: any) => p.chatbotActive !== "true").length}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Patients Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : patients.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              <Stethoscope className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No patients registered yet</p>
              <p className="text-sm">Click "Register Patient" to add a WhatsApp number</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Phone</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Clinic ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {patients.map((p: any) => (
                  <TableRow key={p.phoneNumber}>
                    <TableCell className="font-mono text-sm">{p.phoneNumber}</TableCell>
                    <TableCell>{p.name || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{p.organizationId}</TableCell>
                    <TableCell>
                      <Badge variant={p.chatbotActive === "true" ? "default" : "secondary"}>
                        {p.chatbotActive === "true" ? "Active" : "Paused"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConversationPhone(
                            conversationPhone === p.phoneNumber ? null : p.phoneNumber
                          )}
                          title="View conversation"
                        >
                          <MessageSquare className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            toggleMutation.mutate({
                              phoneNumber: p.phoneNumber,
                              active: p.chatbotActive !== "true",
                            })
                          }
                          title={p.chatbotActive === "true" ? "Pause bot" : "Resume bot"}
                        >
                          {p.chatbotActive === "true" ? (
                            <Pause className="w-4 h-4 text-amber-500" />
                          ) : (
                            <Play className="w-4 h-4 text-emerald-500" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(p.phoneNumber)}
                        >
                          <Trash2 className="w-4 h-4" />
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

      {/* Conversation panel */}
      {conversationPhone && conversationData && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Conversation — {conversationPhone}
            </CardTitle>
            <CardDescription>Recent chatbot messages</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {(conversationData.messages || conversationData || []).length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No messages yet</p>
              ) : (
                (conversationData.messages || conversationData || []).map((msg: any, i: number) => (
                  <div
                    key={i}
                    className={`p-3 rounded-lg text-sm max-w-[80%] ${
                      msg.direction === "outgoing" || msg.metadata?.hims_chatbot_reply
                        ? "ml-auto bg-primary/10 text-right"
                        : "bg-accent/50"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {msg.createdAt ? new Date(msg.createdAt).toLocaleString() : ""}
                    </p>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove patient?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop the OPD chatbot for {deleteTarget}. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
