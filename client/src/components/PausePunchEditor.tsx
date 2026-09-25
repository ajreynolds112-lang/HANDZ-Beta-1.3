import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Lock } from "lucide-react";
import { isValidPin } from "@/lib/pinAuth";
import PunchAnimEditor from "@/components/PunchAnimEditor";

interface PausePunchEditorProps {
  onClose: () => void;
}

export default function PausePunchEditor({ onClose }: PausePunchEditorProps) {
  const [unlocked, setUnlocked] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState(false);

  const tryUnlock = () => {
    if (isValidPin(pinInput)) {
      setUnlocked(true);
      setPinError(false);
    } else {
      setPinError(true);
      setPinInput("");
    }
  };

  if (!unlocked) {
    return (
      <div className="flex flex-col items-center gap-4 max-w-lg mx-auto">
        <div className="sticky top-0 z-10 flex items-center gap-3 w-full bg-black/90 backdrop-blur-sm p-4">
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-back-pause-punch-editor">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="text-xl font-bold flex-1">Punch Animation</h2>
        </div>
        <Card className="p-8 w-[calc(100%-2rem)] text-center space-y-4 mb-4">
          <Lock className="w-12 h-12 mx-auto text-muted-foreground" />
          <h3 className="text-lg font-bold">Admin Access Required</h3>
          <p className="text-sm text-muted-foreground">Enter your admin or career PIN to access punch animation parameters.</p>
          <div className="flex gap-2 justify-center items-center">
            <Input
              type="password"
              maxLength={4}
              value={pinInput}
              onChange={e => {
                setPinInput(e.target.value.replace(/\D/g, ""));
                setPinError(false);
              }}
              onKeyDown={e => { if (e.key === "Enter") tryUnlock(); }}
              placeholder="PIN"
              className="w-24 text-center tracking-widest"
              data-testid="input-pause-punch-editor-pin"
            />
            <Button onClick={tryUnlock} data-testid="button-pause-punch-editor-unlock">Unlock</Button>
          </div>
          {pinError && <p className="text-xs text-destructive">Incorrect PIN</p>}
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 max-w-2xl mx-auto">
      <div className="sticky top-0 z-10 flex items-center gap-3 w-full bg-black/90 backdrop-blur-sm p-4">
        <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-back-pause-punch-editor">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Punch Animation</h2>
      </div>
      <div className="w-full px-4 pb-6">
        <PunchAnimEditor defaultExpanded />
      </div>
    </div>
  );
}
