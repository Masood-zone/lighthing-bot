import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function NotFound() {
  const history = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background">
      <AlertCircle className="w-16 h-16 text-destructive mb-4" />
      <h1 className="text-4xl font-bold mb-2">404 - Page Not Found</h1>
      <p className="text-xl text-muted-foreground mb-6">
        Oops! The page you&apos;re looking for doesn&apos;t exist.
      </p>
      <Button onClick={() => history(-1)}>Go back</Button>
    </div>
  );
}
