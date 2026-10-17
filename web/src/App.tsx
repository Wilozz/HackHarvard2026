import { useState, type FormEvent } from "react";
import { CircleCheck, MessageCircle, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/reui-phone-input";

// The signup form: everyone's name and number in, one iMessage group chat out.
// Same contract as the server's fallback page (src/photon/signup-page.ts):
// POST /api/groups {consent, members: [{name, phone}]}.

const AGENT = "Tripchat";
const MIN_PEOPLE = 2;
const MAX_PEOPLE = 10; // src/photon/signup.ts MAX_MEMBERS

interface Person {
  key: number;
  name: string;
  phone: string;
}

interface Created {
  names: string[];
  agentPhone?: string;
  existing: boolean;
}

let nextKey = 0;
const emptyPerson = (): Person => ({ key: nextKey++, name: "", phone: "" });
const startingPeople = () => [emptyPerson(), emptyPerson(), emptyPerson()];

function listNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export default function App() {
  const [people, setPeople] = useState<Person[]>(startingPeople);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [created, setCreated] = useState<Created>();

  const update = (key: number, change: Partial<Person>) =>
    setPeople((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p)));

  // Keep at least two rows; removing below that just clears the row.
  const remove = (key: number) =>
    setPeople((list) => (list.length > MIN_PEOPLE ? list.filter((p) => p.key !== key) : list.map((p) => (p.key === key ? { ...p, name: "", phone: "" } : p))));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSending(true);
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consent, members: people.map(({ name, phone }) => ({ name, phone })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
      setCreated(data as Created);
    } catch (err) {
      setError(err instanceof TypeError ? "Couldn't reach the server. Is the agent running?" : (err as Error).message);
    } finally {
      setSending(false);
    }
  }

  function startOver() {
    setPeople(startingPeople());
    setConsent(false);
    setCreated(undefined);
  }

  return (
    <main className="mx-auto w-full max-w-xl px-4 pt-14 pb-18 sm:pt-16">
      <div className="mb-5 inline-flex items-center gap-2 font-semibold text-primary">
        <MessageCircle className="size-5" aria-hidden />
        {AGENT}
      </div>
      <h1 className="mb-2.5 text-3xl font-semibold tracking-tight sm:text-4xl">Start your trip chat</h1>
      <p className="mb-7 text-muted-foreground sm:text-lg">
        Add everyone who's coming. {AGENT} starts an iMessage group with all of you and suggests a trip that works for the whole group.
      </p>

      {created ? (
        <section className="rounded-xl border bg-card p-8 text-center" aria-live="polite">
          <CircleCheck className="mx-auto mb-4 size-12 text-green-600" aria-hidden />
          <h2 className="mb-2 text-2xl font-semibold">Check your Messages</h2>
          <p className="mb-3">
            {created.existing
              ? `You already have a group chat with ${listNames(created.names)}, so ${AGENT} didn't send a second welcome. Names are updated.`
              : `${AGENT}${created.agentPhone ? ` (${created.agentPhone})` : ""} just texted ${listNames(created.names)}.`}
          </p>
          <p className="mb-4 text-sm text-muted-foreground">Mention @{AGENT} in the chat whenever you want a trip idea.</p>
          <Button variant="link" onClick={startOver}>
            Start another group
          </Button>
        </section>
      ) : (
        <form onSubmit={submit} noValidate className="rounded-xl border bg-card p-5 sm:p-6">
          <FieldGroup>
            <Field>
              <FieldLabel>Who's in?</FieldLabel>
              <FieldDescription>Pick each person's country from the flag, then type their number.</FieldDescription>
              <ul className="flex flex-col gap-3">
                {people.map((person, i) => (
                  <li key={person.key} className="grid grid-cols-[1fr_auto] gap-2 border-b pb-3 last:border-b-0 sm:grid-cols-[1fr_1.4fr_auto] sm:border-0 sm:pb-0">
                    <Input
                      aria-label={`Person ${i + 1} name`}
                      className="col-span-2 sm:col-span-1"
                      maxLength={40}
                      placeholder={i === 0 ? "Your name" : "Name"}
                      autoComplete="off"
                      value={person.name}
                      onChange={(e) => update(person.key, { name: e.target.value })}
                    />
                    <PhoneInput
                      aria-label={`Person ${i + 1} phone number`}
                      variant="lg"
                      defaultCountry="US"
                      international
                      placeholder="Phone number"
                      value={person.phone}
                      onChange={(phone) => update(person.key, { phone })}
                    />
                    <Button type="button" variant="ghost" size="icon" className="size-9 text-muted-foreground" aria-label={`Remove person ${i + 1}`} onClick={() => remove(person.key)}>
                      <X className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
              {people.length < MAX_PEOPLE && (
                <div>
                  <Button type="button" variant="link" className="h-auto px-0 py-1" onClick={() => setPeople((list) => [...list, emptyPerson()])}>
                    <Plus className="mr-1 size-4" /> Add someone
                  </Button>
                </div>
              )}
            </Field>

            <Field orientation="horizontal" className="items-start">
              <input id="consent" type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <FieldLabel htmlFor="consent" className="font-normal">
                Everyone on this list agreed to be added to a group chat with {AGENT}.
              </FieldLabel>
            </Field>

            <FieldError className="rounded-md bg-destructive/10 px-3 py-2.5">{error}</FieldError>

            <Button type="submit" size="lg" className="w-full" disabled={sending}>
              {sending ? "Starting the chat…" : "Start the group chat"}
            </Button>
          </FieldGroup>
        </form>
      )}
    </main>
  );
}
