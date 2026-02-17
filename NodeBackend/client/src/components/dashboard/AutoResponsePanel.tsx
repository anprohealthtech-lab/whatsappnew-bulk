import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
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
import { MessageSquare, Trash2, Edit2, Bell, BellOff, Info, Plus } from "lucide-react";

interface AutoResponsePanelProps {
    autoResponses: any[];
    onCreate: (data: { keyword: string; response: string }) => void;
    onUpdate: (data: { id: string; keyword?: string; response?: string; isActive?: boolean }) => void;
    onDelete: (id: string) => void;
}

export function AutoResponsePanel({ autoResponses, onCreate, onUpdate, onDelete }: AutoResponsePanelProps) {
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [editTarget, setEditTarget] = useState<any>(null);
    const [deleteTarget, setDeleteTarget] = useState<any>(null);

    // Create form state
    const [createKeyword, setCreateKeyword] = useState("");
    const [createResponse, setCreateResponse] = useState("");

    // Edit form state
    const [editKeyword, setEditKeyword] = useState("");
    const [editResponse, setEditResponse] = useState("");

    const handleCreate = () => {
        if (!createKeyword.trim() || !createResponse.trim()) return;
        onCreate({ keyword: createKeyword.trim(), response: createResponse.trim() });
        setCreateKeyword("");
        setCreateResponse("");
        setShowCreateDialog(false);
    };

    const handleEdit = () => {
        if (!editTarget || !editKeyword.trim() || !editResponse.trim()) return;
        onUpdate({
            id: editTarget.id,
            keyword: editKeyword.trim(),
            response: editResponse.trim(),
        });
        setEditTarget(null);
    };

    const openEditDialog = (autoResponse: any) => {
        setEditKeyword(autoResponse.keyword);
        setEditResponse(autoResponse.response);
        setEditTarget(autoResponse);
    };

    return (
        <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm animate-fade-in-up">
            <CardHeader className="flex flex-row items-center justify-between">
                <div>
                    <CardTitle className="text-lg font-semibold">Auto-Responses</CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">Manage keyword-based automatic replies</p>
                </div>
                <Button
                    onClick={() => setShowCreateDialog(true)}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20"
                >
                    <Plus className="w-4 h-4 mr-2" />
                    Add New
                </Button>
            </CardHeader>
            <CardContent>
                <div className="space-y-4">
                    {autoResponses.length === 0 ? (
                        <div className="text-center py-12 text-muted-foreground bg-accent/20 rounded-xl border border-dashed border-border">
                            <MessageSquare className="w-12 h-12 mx-auto mb-3 text-muted-foreground/50" />
                            <p>No auto-responses configured</p>
                            <p className="text-sm mt-1">Create your first auto-response to get started</p>
                        </div>
                    ) : (
                        autoResponses.map((autoResponse: any) => (
                            <div
                                key={autoResponse.id}
                                className="group bg-white dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 rounded-xl p-4 hover:border-primary/50 hover:shadow-md transition-all duration-300"
                            >
                                <div className="flex items-start justify-between">
                                    <div className="flex-1">
                                        <div className="flex items-center space-x-2 mb-2">
                                            <Badge variant={autoResponse.isActive === 'true' ? 'default' : 'secondary'} className={autoResponse.isActive === 'true' ? 'bg-primary/10 text-primary hover:bg-primary/20' : ''}>
                                                {autoResponse.keyword}
                                            </Badge>
                                            <span className="text-xs text-muted-foreground">
                                                {autoResponse.isActive === 'true' ? 'Active' : 'Inactive'}
                                            </span>
                                        </div>
                                        <p className="text-sm text-foreground">{autoResponse.response}</p>
                                        <p className="text-xs text-muted-foreground mt-2">
                                            Created: {new Date(autoResponse.createdAt).toLocaleDateString()}
                                        </p>
                                    </div>
                                    <div className="flex items-center space-x-1 ml-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                                const newIsActive = autoResponse.isActive === 'true' ? false : true;
                                                onUpdate({
                                                    id: autoResponse.id,
                                                    isActive: newIsActive
                                                });
                                            }}
                                            className="hover:bg-accent"
                                            title={autoResponse.isActive === 'true' ? 'Deactivate' : 'Activate'}
                                        >
                                            {autoResponse.isActive === 'true' ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => openEditDialog(autoResponse)}
                                            className="hover:bg-accent"
                                            title="Edit"
                                        >
                                            <Edit2 className="w-4 h-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setDeleteTarget(autoResponse)}
                                            className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                                            title="Delete"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="mt-6 p-4 bg-primary/5 dark:bg-primary/10 border border-primary/20 dark:border-primary/20 rounded-xl">
                    <h4 className="flex items-center font-medium text-sm text-foreground mb-2">
                        <Info className="w-4 h-4 mr-2 text-primary" />
                        How Auto-Responses Work
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1 ml-6 list-disc">
                        <li>Keywords are matched case-insensitively</li>
                        <li>First matching keyword triggers the response</li>
                        <li>Responses are sent automatically when recipients reply with matching keywords</li>
                        <li>Example: When someone replies "YES", send "Thank you for your interest!"</li>
                    </ul>
                </div>
            </CardContent>

            {/* Create Dialog */}
            <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
                <DialogContent className="border-none shadow-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl">
                    <DialogHeader>
                        <DialogTitle>Create Auto-Response</DialogTitle>
                        <DialogDescription>
                            Set up a keyword-triggered automatic reply for incoming messages.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="create-keyword">Keyword</Label>
                            <Input
                                id="create-keyword"
                                value={createKeyword}
                                onChange={(e) => setCreateKeyword(e.target.value)}
                                placeholder="e.g., YES, INTERESTED, HELP"
                                className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="create-response">Auto-Response Message</Label>
                            <Textarea
                                id="create-response"
                                value={createResponse}
                                onChange={(e) => setCreateResponse(e.target.value)}
                                placeholder="Thank you for your interest! We'll get back to you shortly."
                                rows={3}
                                className="resize-none bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={handleCreate}
                            disabled={!createKeyword.trim() || !createResponse.trim()}
                            className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-md shadow-primary/20"
                        >
                            Create
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Edit Dialog */}
            <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
                <DialogContent className="border-none shadow-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl">
                    <DialogHeader>
                        <DialogTitle>Edit Auto-Response</DialogTitle>
                        <DialogDescription>
                            Update the keyword and response message.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="edit-keyword">Keyword</Label>
                            <Input
                                id="edit-keyword"
                                value={editKeyword}
                                onChange={(e) => setEditKeyword(e.target.value)}
                                placeholder="e.g., YES, INTERESTED"
                                className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="edit-response">Auto-Response Message</Label>
                            <Textarea
                                id="edit-response"
                                value={editResponse}
                                onChange={(e) => setEditResponse(e.target.value)}
                                placeholder="Response message..."
                                rows={3}
                                className="resize-none bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setEditTarget(null)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={handleEdit}
                            disabled={!editKeyword.trim() || !editResponse.trim()}
                            className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-md shadow-primary/20"
                        >
                            Save Changes
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete Confirmation */}
            <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
                <AlertDialogContent className="border-none shadow-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl">
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete Auto-Response</AlertDialogTitle>
                        <AlertDialogDescription>
                            Are you sure you want to delete the auto-response for keyword <span className="font-semibold">"{deleteTarget?.keyword}"</span>? This action cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                if (deleteTarget) {
                                    onDelete(deleteTarget.id);
                                    setDeleteTarget(null);
                                }
                            }}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Card>
    );
}
