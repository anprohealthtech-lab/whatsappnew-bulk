import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { FileUp, Send, FileText } from "lucide-react";

interface ReportFormProps {
    form: any;
    onSubmit: (data: any) => void;
    isLoading: boolean;
    selectedFile: File | null;
    onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
    onFileDrop: (event: React.DragEvent<HTMLDivElement>) => void;
}

export function ReportForm({ form, onSubmit, isLoading, selectedFile, onFileSelect, onFileDrop }: ReportFormProps) {
    return (
        <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
            <CardHeader>
                <CardTitle className="flex items-center text-lg font-semibold">
                    <FileText className="w-5 h-5 mr-2 text-primary" />
                    Send Report
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div
                    className="border-2 border-dashed border-gray-200 dark:border-zinc-800 rounded-xl p-8 text-center hover:border-primary/50 hover:bg-primary/5 transition-all duration-300 cursor-pointer mb-6 group"
                    onDrop={onFileDrop}
                    onDragOver={(e) => e.preventDefault()}
                    onClick={() => document.getElementById('file-input')?.click()}
                >
                    <input
                        id="file-input"
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png"
                        onChange={onFileSelect}
                        className="hidden"
                    />
                    <div className="space-y-4">
                        <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                            <FileUp className="text-primary text-2xl" />
                        </div>
                        <div>
                            {selectedFile ? (
                                <div className="bg-primary/10 px-4 py-2 rounded-full inline-block">
                                    <p className="text-sm text-primary font-medium">{selectedFile.name}</p>
                                </div>
                            ) : (
                                <>
                                    <p className="text-sm font-medium text-foreground">Drag and drop your report here</p>
                                    <p className="text-xs text-muted-foreground mt-1">PDF, JPG, PNG up to 10MB</p>
                                </>
                            )}
                        </div>
                        {!selectedFile && (
                            <Button type="button" variant="outline" size="sm" className="mt-2">
                                Browse Files
                            </Button>
                        )}
                    </div>
                </div>

                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <FormField
                            control={form.control}
                            name="phoneNumber"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Phone Number</FormLabel>
                                    <FormControl>
                                        <Input
                                            placeholder="+1234567890"
                                            {...field}
                                            className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <FormField
                            control={form.control}
                            name="sampleId"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Patient/Sample ID</FormLabel>
                                    <FormControl>
                                        <Input
                                            placeholder="e.g. SAMPLE-2024-001"
                                            {...field}
                                            className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <FormField
                            control={form.control}
                            name="content"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Message (Optional)</FormLabel>
                                    <FormControl>
                                        <Input
                                            placeholder="Custom message..."
                                            {...field}
                                            className="bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <Button
                            type="submit"
                            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 transition-all duration-200"
                            disabled={isLoading || !selectedFile}
                        >
                            <Send className="w-4 h-4 mr-2" />
                            Send Report
                        </Button>
                    </form>
                </Form>
            </CardContent>
        </Card>
    );
}
