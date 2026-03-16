import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Loader2, Plus, Save, Trash2, UserRound } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type Recipient = {
  id: string;
  phoneNumber: string;
  label: string | null;
  notifyOnLeadCreated: string;
  notifyOnDemoScheduled: string;
  notifyOnBookingConfirmed: string;
  isActive: string;
};

type RecipientFormState = {
  phoneNumber: string;
  label: string;
  notifyOnLeadCreated: boolean;
  notifyOnDemoScheduled: boolean;
  notifyOnBookingConfirmed: boolean;
  isActive: boolean;
};

const EMPTY_FORM: RecipientFormState = {
  phoneNumber: "",
  label: "",
  notifyOnLeadCreated: true,
  notifyOnDemoScheduled: true,
  notifyOnBookingConfirmed: true,
  isActive: true,
};

function toFormState(recipient?: Recipient): RecipientFormState {
  if (!recipient) return EMPTY_FORM;
  return {
    phoneNumber: recipient.phoneNumber || "",
    label: recipient.label || "",
    notifyOnLeadCreated: recipient.notifyOnLeadCreated !== "false",
    notifyOnDemoScheduled: recipient.notifyOnDemoScheduled !== "false",
    notifyOnBookingConfirmed: recipient.notifyOnBookingConfirmed !== "false",
    isActive: recipient.isActive !== "false",
  };
}

function normalizePhone(phoneNumber: string) {
  return phoneNumber.replace(/\D/g, "");
}

export function NotificationRecipientsPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formState, setFormState] = useState<RecipientFormState>(EMPTY_FORM);

  const { data, isLoading } = useQuery({
    queryKey: ["/api/notification-recipients"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/notification-recipients");
      return response.json();
    },
  });

  const recipients: Recipient[] = useMemo(() => data?.data || [], [data]);

  const refreshRecipients = () =>
    queryClient.invalidateQueries({ queryKey: ["/api/notification-recipients"] });

  const saveMutation = useMutation({
    mutationFn: async (payload: RecipientFormState & { id?: string }) => {
      const body = {
        phoneNumber: normalizePhone(payload.phoneNumber),
        label: payload.label || undefined,
        notifyOnLeadCreated: payload.notifyOnLeadCreated,
        notifyOnDemoScheduled: payload.notifyOnDemoScheduled,
        notifyOnBookingConfirmed: payload.notifyOnBookingConfirmed,
        isActive: payload.isActive,
      };

      const response = payload.id
        ? await apiRequest("PUT", `/api/notification-recipients/${payload.id}`, body)
        : await apiRequest("POST", "/api/notification-recipients", body);

      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Notification recipient saved" });
      setEditingId(null);
      setFormState(EMPTY_FORM);
      refreshRecipients();
    },
    onError: (error: any) => {
      toast({
        title: "Unable to save recipient",
        description: error.message || "Please check the phone number and try again.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await apiRequest("DELETE", `/api/notification-recipients/${id}`);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Notification recipient removed" });
      if (editingId) {
        setEditingId(null);
        setFormState(EMPTY_FORM);
      }
      refreshRecipients();
    },
    onError: (error: any) => {
      toast({
        title: "Unable to delete recipient",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const startCreate = () => {
    setEditingId(null);
    setFormState(EMPTY_FORM);
  };

  const startEdit = (recipient: Recipient) => {
    setEditingId(recipient.id);
    setFormState(toFormState(recipient));
  };

  const handleSave = () => {
    const normalized = normalizePhone(formState.phoneNumber);
    if (normalized.length < 10) {
      toast({
        title: "Phone number required",
        description: "Enter at least a 10 digit WhatsApp number.",
        variant: "destructive",
      });
      return;
    }

    saveMutation.mutate({ ...formState, id: editingId || undefined });
  };

  return (
    <div className="space-y-6 animate-fade-in-up">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BellRing className="w-5 h-5 text-primary" />
            Internal Notifications
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Send user-specific WhatsApp alerts to your team when a lead is captured, a demo is scheduled, or a booking gets confirmed.
          </p>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Recipient Number</Label>
              <Input
                value={formState.phoneNumber}
                onChange={(e) => setFormState((prev) => ({ ...prev, phoneNumber: e.target.value }))}
                placeholder="9198XXXXXXXX"
              />
            </div>
            <div className="space-y-2">
              <Label>Label</Label>
              <Input
                value={formState.label}
                onChange={(e) => setFormState((prev) => ({ ...prev, label: e.target.value }))}
                placeholder="Reception, Owner, Sales Desk"
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="font-medium">Lead Captured</p>
                <p className="text-xs text-muted-foreground">Send alert when chatbot flags a new lead.</p>
              </div>
              <Switch
                checked={formState.notifyOnLeadCreated}
                onCheckedChange={(checked) => setFormState((prev) => ({ ...prev, notifyOnLeadCreated: checked }))}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="font-medium">Demo Scheduled</p>
                <p className="text-xs text-muted-foreground">Send alert when a demo gets booked from the Leads panel.</p>
              </div>
              <Switch
                checked={formState.notifyOnDemoScheduled}
                onCheckedChange={(checked) => setFormState((prev) => ({ ...prev, notifyOnDemoScheduled: checked }))}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="font-medium">Booking Confirmed</p>
                <p className="text-xs text-muted-foreground">Send alert when the lead conversation clearly confirms booking.</p>
              </div>
              <Switch
                checked={formState.notifyOnBookingConfirmed}
                onCheckedChange={(checked) => setFormState((prev) => ({ ...prev, notifyOnBookingConfirmed: checked }))}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="font-medium">Recipient Active</p>
                <p className="text-xs text-muted-foreground">Pause this recipient without deleting it.</p>
              </div>
              <Switch
                checked={formState.isActive}
                onCheckedChange={(checked) => setFormState((prev) => ({ ...prev, isActive: checked }))}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button onClick={handleSave} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {editingId ? "Update Recipient" : "Add Recipient"}
            </Button>
            <Button variant="outline" onClick={startCreate}>
              <Plus className="mr-2 h-4 w-4" />
              New Recipient
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserRound className="w-5 h-5 text-primary" />
            Configured Recipients
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : recipients.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              No notification recipients added yet.
            </p>
          ) : (
            <div className="space-y-3">
              {recipients.map((recipient) => (
                <div key={recipient.id} className="flex flex-col gap-3 rounded-xl border p-4 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-1">
                    <p className="font-medium">{recipient.label || "Unnamed recipient"}</p>
                    <p className="text-sm text-muted-foreground">{recipient.phoneNumber}</p>
                    <p className="text-xs text-muted-foreground">
                      {[
                        recipient.notifyOnLeadCreated !== "false" ? "Lead" : null,
                        recipient.notifyOnDemoScheduled !== "false" ? "Demo" : null,
                        recipient.notifyOnBookingConfirmed !== "false" ? "Booking" : null,
                      ].filter(Boolean).join(" • ") || "No events enabled"}
                      {recipient.isActive === "false" ? " • Paused" : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => startEdit(recipient)}>
                      Edit
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => deleteMutation.mutate(recipient.id)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
