import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuthStore } from "@/lib/auth";
import { useLogin } from "@workspace/api-client-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function Login() {
  const [, setLocation] = useLocation();
  const token = useAuthStore(state => state.token);
  const setToken = useAuthStore(state => state.setToken);
  const { toast } = useToast();

  // If already logged in, go straight to dashboard
  useEffect(() => {
    if (token) setLocation("/dashboard");
  }, [token, setLocation]);
  
  const { register, handleSubmit, formState: { errors } } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" }
  });

  const loginMutation = useLogin();

  const onSubmit = (data: LoginFormValues) => {
    loginMutation.mutate(
      { data },
      {
        onSuccess: (res) => {
          setToken(res.token);
          toast({ title: "Welcome back", description: `Logged in as ${res.user.first_name}` });
          setLocation("/dashboard");
        },
        onError: () => {
          toast({ variant: "destructive", title: "Login Failed", description: "Invalid email or password" });
        }
      }
    );
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background dark p-4">
      {/* Abstract dark shapes in background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-20">
        <div className="absolute -top-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-primary blur-[120px]" />
        <div className="absolute -bottom-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-secondary blur-[120px]" />
      </div>

      <Card className="w-full max-w-md p-8 bg-card border-border shadow-2xl relative z-10">
        <div className="text-center mb-8 flex flex-col items-center">
          <div style={{ backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '10px 16px', marginBottom: '20px', display: 'inline-block' }}>
            <img src="/phes-logo.jpeg" alt="PHES Cleaning LLC" style={{ height: '52px', width: 'auto', objectFit: 'contain', display: 'block' }} />
          </div>
          <h1 className="text-3xl font-display font-bold text-white tracking-tight">CleanOps Pro</h1>
          <p className="text-muted-foreground mt-2 font-medium">Sign in to your workspace</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-muted-foreground uppercase text-xs tracking-wider">Email Address</Label>
            <Input 
              id="email" 
              type="email" 
              placeholder="owner@phescleaning.com"
              className="bg-background border-border focus:border-primary focus:ring-1 focus:ring-primary h-12"
              {...register("email")} 
            />
            {errors.email && <p className="text-sm text-destructive mt-1">{errors.email.message}</p>}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password" className="text-muted-foreground uppercase text-xs tracking-wider">Password</Label>
              <a href="#" className="text-xs text-primary hover:underline">Forgot password?</a>
            </div>
            <Input 
              id="password" 
              type="password" 
              placeholder="••••••••"
              className="bg-background border-border focus:border-primary focus:ring-1 focus:ring-primary h-12"
              {...register("password")} 
            />
            {errors.password && <p className="text-sm text-destructive mt-1">{errors.password.message}</p>}
          </div>

          <Button 
            type="submit" 
            className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-bold text-lg shadow-lg shadow-primary/20"
            disabled={loginMutation.isPending}
          >
            {loginMutation.isPending ? "Signing in..." : "Sign In"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
