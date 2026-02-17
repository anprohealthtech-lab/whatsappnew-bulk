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
import { UserPlus, MessageSquare, Calendar, Trash2, Pause, Play, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const flagLeadSchema = z.object({
  phoneNumber: z.string().min(10, "Phone number must be at least 10 digits"),
  name: z.string().optional(),
  keyword: z.string().optional(),
});

type FlagLeadFormData = z.infer<typeof flagLeadSchema>;

export function LeadsPanel() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
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
  const { data: leadsData, isLoading } = useQuery<{ leads: any[] }>({
    queryKey: ["/api/leads"],
    refetchInterval: 30000,
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

  // Mutation to delete a lead
  const deleteLeadMutation = useMutation({
    mutationFn: async (phoneNumber: string) => {
      const response = await fetch(`/api/leads/${encodeURIComponent(phoneNumber)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete lead");
      }

      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Success",
        description: "Lead removed successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
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
      const response = await fetch(`/api/leads/${encodeURIComponent(phoneNumber)}/chatbot-status`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
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
        description: variables.active ? "Chatbot enabled" : "Chatbot paused - you can chat manually",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
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
    <div className="space-y-6 animate-fade-in-up">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Leads Management</h2>
          <p className="text-muted-foreground text-sm">
            View and manage leads detected by the chatbot system
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20">
              <UserPlus className="mr-2 h-4 w-4" />
              Add Past Lead
            </Button>
          </DialogTrigger>
          <DialogContent className="border-none shadow-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl">
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
                  className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
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
                  className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="keyword">Trigger Keyword (Optional)</Label>
                <Input
                  id="keyword"
                  placeholder="Manual flag"
                  {...form.register("keyword")}
                  className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
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
                <Button
                  type="submit"
                  disabled={flagLeadMutation.isPending}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-md shadow-primary/20"
                >
                  {flagLeadMutation.isPending ? "Adding..." : "Add Lead"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Active Leads</CardTitle>
          <CardDescription>
            Contacts that have been flagged as leads and will receive chatbot auto-responses
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="flex items-center space-x-4 p-4">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-6 w-16 rounded-full" />
                  <Skeleton className="h-5 w-28" />
                  <Skeleton className="h-8 w-24" />
                </div>
              ))}
            </div>
          ) : leads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center bg-accent/20 rounded-xl border border-dashed border-border">
              <UserPlus className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <p className="text-lg font-medium">No leads yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Leads will appear here when contacts send trigger keywords or are manually added
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-zinc-800">
              <Table>
                <TableHeader>
                  <TableRow className="bg-gray-50 dark:bg-zinc-900/50 hover:bg-gray-50 dark:hover:bg-zinc-900/50">
                    <TableHead className="font-medium text-muted-foreground">Phone Number</TableHead>
                    <TableHead className="font-medium text-muted-foreground">Name</TableHead>
                    <TableHead className="font-medium text-muted-foreground">Trigger Keyword</TableHead>
                    <TableHead className="font-medium text-muted-foreground">Status</TableHead>
                    <TableHead className="font-medium text-muted-foreground">Last Message</TableHead>
                    <TableHead className="font-medium text-muted-foreground">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leads.map((lead: any) => (
                    <TableRow key={lead.id} className="hover:bg-gray-50 dark:hover:bg-zinc-900/50 transition-colors">
                      <TableCell className="font-mono text-foreground">
                        {lead.phoneNumber}
                      </TableCell>
                      <TableCell className="text-foreground">{lead.name || <span className="text-muted-foreground">--</span>}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-normal bg-primary/10 text-primary hover:bg-primary/20">
                          {lead.leadTriggerKeyword || "Unknown"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {lead.chatbotActive === 'false' ? (
                          <Badge variant="outline" className="border-yellow-500/50 text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20">
                            Paused
                          </Badge>
                        ) : (
                          <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-200">
                            Active
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {formatTimestamp(lead.lastMessageAt)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              const isActive = lead.chatbotActive !== 'false';
                              toggleChatbotMutation.mutate({
                                phoneNumber: lead.phoneNumber,
                                active: !isActive,
                              });
                            }}
                            disabled={toggleChatbotMutation.isPending}
                            title={lead.chatbotActive === 'false' ? 'Resume chatbot' : 'Pause chatbot for manual chat'}
                            className="hover:bg-accent"
                          >
                            {lead.chatbotActive === 'false' ? (
                              <Play className="h-4 w-4 text-green-600 dark:text-green-400" />
                            ) : (
                              <Pause className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              toast({
                                title: "Coming soon",
                                description: "Conversation view will be available soon",
                              });
                            }}
                            className="text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                          >
                            <MessageSquare className="h-4 w-4 mr-1" />
                            View Chat
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteTarget(lead.phoneNumber)}
                            disabled={deleteLeadMutation.isPending}
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

          {leads.length > 0 && (
            <div className="mt-4 text-sm text-muted-foreground">
              Total leads: {leads.length}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Info Card */}
      <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-base flex items-center">
            <Info className="w-4 h-4 mr-2 text-primary" />
            How Leads Work
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            <strong className="text-foreground">Automatic Detection:</strong> When a contact sends a message containing any of your configured trigger keywords, they are automatically flagged as a lead.
          </p>
          <p>
            <strong className="text-foreground">Chatbot Responses:</strong> All messages from leads are sent to the RAG chatbot, which provides intelligent, context-aware responses.
          </p>
          <p>
            <strong className="text-foreground">Manual Addition:</strong> You can manually flag past contacts as leads using the "Add Past Lead" button above. This is useful for importing existing prospects.
          </p>
          <p>
            <strong className="text-foreground">Context:</strong> The chatbot receives the last 5 messages from each conversation to provide relevant responses.
          </p>
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="border-none shadow-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Lead</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove <span className="font-mono font-semibold">{deleteTarget}</span> from leads? This will disable chatbot auto-responses for this contact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) {
                  deleteLeadMutation.mutate(deleteTarget);
                  setDeleteTarget(null);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove Lead
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
