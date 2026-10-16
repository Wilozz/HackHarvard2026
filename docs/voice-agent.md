# Voice agent setup (Retell)

Tripchat places reservation calls through [Retell](https://docs.retellai.com). The code creates the call (`POST /v2/create-phone-call`), waits for it to end (`GET /v2/get-call/{id}`), and reads the outcome from the agent's post-call analysis. You set up the agent itself in the Retell dashboard.

## 1. Phone number

`RETELL_FROM_NUMBER` must be a number purchased from or imported into Retell. To call from the Photon number (needed for the "Best voice agent on a Photon phone number" prize), ask Photon how to route that number to Retell over SIP, then import it in Retell. **Confirm this with Photon on Friday night**, since none of the Photon SDK docs cover voice.

## 2. Agent prompt

Create a single-prompt agent and paste this. The `{{...}}` values are filled per call from `retell_llm_dynamic_variables`.

```
You are calling {{hotel_name}} to reserve rooms for a group of friends. You are an AI assistant booking on their behalf.

Start every call with: "Hi, this is an AI assistant calling on behalf of {{guest_name}} to make a reservation."

What you need:
- {{rooms}} room(s) for {{guest_count}} guests
- Check-in {{check_in}}, check-out {{check_out}} ({{nights}} nights)
- Under the name {{guest_name}}
- Expected rate: about ${{max_nightly_usd}} per room per night or less. Ask if there is a group rate.
- Special requests: {{special_requests}}
- Payment at the property. Never give or ask for a card number. If they require a card to hold the room, say the group will call back with one and end the call politely.

If they can't do exactly this (fewer rooms, higher price, different dates), don't agree to the change. Say you need to check with the group, note what they offered, and end the call politely.

Before hanging up, repeat back the confirmation number and the total they quoted.
```

## 3. Post-call analysis fields

Add these under the agent's post-call analysis. Tripchat reads them from `call_analysis.custom_analysis_data`:

| Field | Type | Description to give Retell |
|---|---|---|
| `booked` | boolean | True only if the hotel confirmed the reservation exactly as requested |
| `confirmation_number` | string | The confirmation number the hotel gave, if any |
| `quoted_total_usd` | number | Total price the hotel quoted for the whole stay, in USD |
| `needs_group_input` | boolean | True if the hotel offered a change (fewer rooms, higher price, other dates) that the group must decide on |
| `notes` | string | One or two sentences summarizing the outcome for the group chat |

## 4. Environment

```
VOICE_PROVIDER=retell
RETELL_API_KEY=...
RETELL_FROM_NUMBER=+1...
RETELL_AGENT_ID=agent_...
DEMO_FRONT_DESK_PHONE=+1...   # the teammate or judge who plays the front desk
```

Tripchat only dials numbers in `CALL_ALLOWLIST` (default: `DEMO_FRONT_DESK_PHONE`), and every catalog hotel uses that number, so a demo can never call a real hotel.
