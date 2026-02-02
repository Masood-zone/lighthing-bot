import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";

export default function Error({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error(error);
  }, [error]);

  return (
    <div className="flex items-center justify-center min-h-[80dvh]">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex flex-col items-center">
            <AlertTriangle className="w-12 h-12 text-destructive mb-2" />
            <h1 className="text-2xl font-bold text-center">
              Oops! Something went wrong
            </h1>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-center text-muted-foreground mb-4">
            We&apos;re sorry, but an error occurred while processing your
            request.
          </p>
          <div className="bg-destructive/10 border border-destructive text-destructive px-4 py-2 rounded-md mb-4 text-center">
            <p className="font-semibold">Error details:</p>
            <p className="text-sm">{error.message}</p>
          </div>
        </CardContent>
        <CardFooter className="flex justify-center">
          <Button onClick={reset}>Try again</Button>
        </CardFooter>
      </Card>
    </div>
  );
}
