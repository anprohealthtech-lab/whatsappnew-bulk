import { useState } from "react";
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
import { UserPlus, MessageSquare, Calendar } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const flagLeadSchema = z.object({
  phoneNumber: z.string().min(10, "Phone number must be at least 10 digits"),
  name: z.string().optional(),
  keyword: z.string().optional(),
});

type FlagLeadFormData = z.infer<typeof flagLeadSchema>;

export function LeadsPanel() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<FlagLeadFormData>({
    resolver: zodResolver(flagLeadSchema),
    defaultValues: {
      phoneNumber: "",
      name: "",
      keyword: "",
    },
  });

  // Query leads
  const { data: leadsData, isLoading } = useQuery({
    queryKey: ["/api/leads"],
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const leads = leadsData?.leads || [];

  // Mutation to flag a lead
  const flagLeadMutation = useMutation({
    mutationFn: async (data: FlagLeadFormData) => {
      const response = await fetch("/api/leads/flag", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phoneNumber: data.phoneNumber,
          name: data.name || undefined,
          keyword: data.keyword || "Manual flag",
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to flag lead");
      }

      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Success",
        description: "Lead flagged successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      form.reset();
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

  const onSubmit = (data: FlagLeadFormData) => {
    flagLeadMutation.mutate(data);
  };

  const formatTimestamp = (timestamp: string | null) => {
    if (!timestamp) return "Never";
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Leads Management</h2>
          <p className="text-muted-foreground">
            View and manage leads detected by the chatbot system
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <UserPlus className="mr-2 h-4 w-4" />
              Add Past Lead
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Past Lead</DialogTitle>
              <DialogDescription>
                Manually flag a phone number as a lead. This will enable chatbot auto-responses for this contact.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="phoneNumber">Phone Number *</Label>
                <Input
                  id="phoneNumber"
                  placeholder="919876543210"
                  {...form.register("phoneNumber")}
                />
                {form.formState.errors.phoneNumber && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.phoneNumber.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Contact Name (Optional)</Label>
                <Input
                  id="name"
                  placeholder="John Doe"
                  {...form.register("name")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="keyword">Trigger Keyword (Optional)</Label>
                <Input
                  id="keyword"
                  placeholder="Manual flag"
                  {...form.register("keyword")}
                />
                <p className="text-xs text-muted-foreground">
                  Leave blank to use "Manual flag" as default
                </p>
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={flagLeadMutation.isPending}>
                  {flagLeadMutation.isPending ? "Adding..." : "Add Lead"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active Leads</CardTitle>
          <CardDescription>
            Contacts that have been flagged as leads and will receive chatbot auto-responses
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-muted-foreground">Loading leads...</div>
            </div>
          ) : leads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <UserPlus className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-lg font-medium">No leads yet</p>
              <p className="text-sm text-muted-foreground">
                Leads will appear here when contacts send trigger keywords or are manually added
              </p>
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Phone Number</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Trigger Keyword</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last Message</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leads.map((lead: any) => (
                    <TableRow key={lead.id}>
                      <TableCell className="font-mono">
                        {lead.phoneNumber}
                      </TableCell>
                      <TableCell>{lead.name || "—"}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-normal">
                          {lead.leadTriggerKeyword || "Unknown"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="default">
                          Active Lead
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {formatTimestamp(lead.lastMessageAt)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            // TODO: Open conversation view
                            toast({
                              title: "Coming soon",
                              description: "Conversation view will be available soon",
                            });
                          }}
                        >
                          <MessageSquare className="h-4 w-4 mr-1" />
                          View Chat
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {leads.length > 0 && (
            <div className="mt-4 text-sm text-muted-foreground">
              Total leads: {leads.length}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Info Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How Leads Work</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            <strong>Automatic Detection:</strong> When a contact sends a message containing any of your configured trigger keywords, they are automatically flagged as a lead.
          </p>
          <p>
            <strong>Chatbot Responses:</strong> All messages from leads are sent to the RAG chatbot, which provides intelligent, context-aware responses.
          </p>
          <p>
            <strong>Manual Addition:</strong> You can manually flag past contacts as leads using the "Add Past Lead" button above. This is useful for importing existing prospects.
          </p>
          <p>
            <strong>Context:</strong> The chatbot receives the last 5 messages from each conversation to provide relevant responses.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
