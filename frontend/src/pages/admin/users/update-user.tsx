import {
  Field,
  FieldContent,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  BotUser,
  CreateUserInput,
  UpdateUserInput,
} from "@/services/users/users.types";
import { Button } from "@/components/ui/button";
import { useMemo } from "react";
import { useForm, useWatch } from "react-hook-form";
import {
  DatePreferencesPicker,
  type DatePreferencesValue,
} from "@/components/ui/date-preferences-picker";

const DEFAULT_LOGIN_URL = "https://www.usvisaappt.com/visaapplicantui/login";

type CreateFormValues = CreateUserInput;

type EditFormValues = UpdateUserInput & {
  password?: string;
};

export default function UpsertUserDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  initial?: BotUser | null;
  onCreate: (values: CreateFormValues) => Promise<void>;
  onEdit: (values: EditFormValues) => Promise<void>;
  pending: boolean;
  errorMessage?: string;
}) {
  const { open, onOpenChange, mode, initial, pending, errorMessage } = props;

  const createDefaults: CreateFormValues = useMemo(
    () => ({
      loginUrl: DEFAULT_LOGIN_URL,
      email: "",
      password: "",
      displayName: "",

      dateStart: null,
      dateEnd: null,
      daysFromNowMin: null,
      daysFromNowMax: null,
      weeksFromNowMin: null,
      weeksFromNowMax: null,
    }),
    [],
  );

  const editDefaults: EditFormValues = useMemo(
    () => ({
      email: initial?.config?.email,
      displayName: initial?.config?.displayName,
      password: "",

      dateStart: initial?.config?.dateStart ?? null,
      dateEnd: initial?.config?.dateEnd ?? null,
      daysFromNowMin: initial?.config?.daysFromNowMin ?? null,
      daysFromNowMax: initial?.config?.daysFromNowMax ?? null,
      weeksFromNowMin: initial?.config?.weeksFromNowMin ?? null,
      weeksFromNowMax: initial?.config?.weeksFromNowMax ?? null,
    }),
    [initial],
  );

  const form = useForm<CreateFormValues | EditFormValues>({
    defaultValues: mode === "create" ? createDefaults : editDefaults,
    values: mode === "create" ? createDefaults : editDefaults,
  });

  const prefs = useWatch<CreateFormValues | EditFormValues>({
    control: form.control,
    name: [
      "dateStart",
      "dateEnd",
      "daysFromNowMin",
      "daysFromNowMax",
      "weeksFromNowMin",
      "weeksFromNowMax",
    ],
  });

  const prefsValue: DatePreferencesValue = {
    dateStart: prefs?.[0] as string | null | undefined,
    dateEnd: prefs?.[1] as string | null | undefined,
    daysFromNowMin: prefs?.[2] as number | null | undefined,
    daysFromNowMax: prefs?.[3] as number | null | undefined,
    weeksFromNowMin: prefs?.[4] as number | null | undefined,
    weeksFromNowMax: prefs?.[5] as number | null | undefined,
  };

  const setPrefs = (patch: Partial<DatePreferencesValue>) => {
    (Object.keys(patch) as Array<keyof DatePreferencesValue>).forEach((k) => {
      form.setValue(k as never, patch[k] as never, { shouldDirty: true });
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o: boolean) => !pending && onOpenChange(o)}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Create User" : "Edit User"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Add a new user for booking-hunt automation."
              : "Update this user’s booking-hunt configuration."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="mt-4 space-y-4"
          onSubmit={form.handleSubmit(async (values) => {
            if (mode === "create") {
              await props.onCreate(values as CreateFormValues);
            } else {
              const patch = { ...(values as EditFormValues) };
              // Password is optional in edit; avoid sending empty string.
              if (!patch.password) delete patch.password;
              // These fields are intentionally not editable from the UI.
              delete (patch as Partial<CreateUserInput>).loginUrl;
              delete (patch as Partial<CreateUserInput>).pickupPoint;
              delete (patch as Partial<CreateUserInput>).headless;
              await props.onEdit(patch);
            }
          })}
        >
          <FieldGroup>
            {/* Login URL is required by the backend but fixed by the app. */}
            <input type="hidden" {...form.register("loginUrl")} />

            <Field>
              <FieldLabel>
                <FieldTitle>Email</FieldTitle>
              </FieldLabel>
              <FieldContent>
                <Input
                  type="email"
                  placeholder="user@example.com"
                  {...form.register("email", { required: true })}
                  disabled={pending}
                />
                <FieldError
                  errors={[
                    form.formState.errors.email as
                      | { message?: string }
                      | undefined,
                  ]}
                />
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel>
                <FieldTitle>
                  Password{mode === "edit" ? " (leave blank to keep)" : ""}
                </FieldTitle>
              </FieldLabel>
              <FieldContent>
                <Input
                  type="password"
                  placeholder={mode === "create" ? "••••••••" : "(unchanged)"}
                  {...form.register("password", {
                    required: mode === "create",
                  })}
                  disabled={pending}
                />
                <FieldError
                  errors={[
                    form.formState.errors.password as
                      | { message?: string }
                      | undefined,
                  ]}
                />
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel>
                <FieldTitle>Display Name</FieldTitle>
              </FieldLabel>
              <FieldContent>
                <Input
                  placeholder="Jane Doe"
                  {...form.register("displayName", { required: true })}
                  disabled={pending}
                />
                <FieldError
                  errors={[
                    form.formState.errors.displayName as
                      | { message?: string }
                      | undefined,
                  ]}
                />
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel>
                <FieldTitle>Appointment timeline (optional)</FieldTitle>
              </FieldLabel>
              <FieldContent>
                <div className="text-sm text-muted-foreground">
                  Leave as default to search across the full year, or set a
                  custom window.
                </div>
                <div className="mt-3">
                  <DatePreferencesPicker
                    value={prefsValue}
                    onChange={setPrefs}
                    disabled={pending}
                  />
                </div>
              </FieldContent>
            </Field>
          </FieldGroup>

          {errorMessage ? (
            <div className="text-sm text-destructive">{errorMessage}</div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="w-full sm:w-auto"
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="w-full sm:w-auto"
              disabled={pending}
            >
              {pending ? "Saving..." : mode === "create" ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
