import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { MessageSquare, Send } from "lucide-react";

interface MessageFormProps {
    form: any;
    onSubmit: (data: any) => void;
    isLoading: boolean;
}

export function MessageForm({ form, onSubmit, isLoading }: MessageFormProps) {
    return (
        <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
            <CardHeader>
                <CardTitle className="flex items-center text-lg font-semibold">
                    <Send className="w-5 h-5 mr-2 text-primary" />
                    Quick Message
                </CardTitle>
            </CardHeader>
            <CardContent>
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
                            name="content"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Message Content</FormLabel>
                                    <FormControl>
                                        <Textarea
                                            rows={4}
                                            placeholder="Type your message here..."
                                            className="resize-none bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 focus:ring-primary"
                                            {...field}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <Button
                            type="submit"
                            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 transition-all duration-200"
                            disabled={isLoading}
                        >
                            <MessageSquare className="w-4 h-4 mr-2" />
                            Send Message
                        </Button>
                    </form>
                </Form>
            </CardContent>
        </Card>
    );
}
