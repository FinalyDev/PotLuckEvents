# 🥘 Potluck

A static potluck planner for GitHub Pages. Google sign-in and data storage run on Firebase (free Spark plan is plenty).

## Features
- **Google sign-in** — nothing is visible until you sign in.
- **Hosts** create a potluck with name, location (links to Google Maps), date/time and notes, and can edit them later.
- **Invite link** — host copies/shares a link; anyone who opens it and signs in joins. "Reset link" kills the old one (existing guests stay). Hosts can remove guests.
- **Categories** — host adds, renames and deletes them (defaults offered on creation).
- **Items** — each guest adds and edits what they're bringing (name, category, amount, notes). The host can edit anyone's.
- **History is kept** — nothing is hard-deleted. Removed items are soft-deleted, every change is written to an append-only activity log (with before/after values), and past events stay under "Past potlucks".

## Setup (about 10 minutes)

1. **Create a Firebase project** at https://console.firebase.google.com → Add app → **Web**. Copy the config object into `firebase-config.js`.
2. **Enable Google sign-in:** Build → Authentication → Sign-in method → Google → Enable.
   Then Authentication → Settings → **Authorized domains** → add `YOURNAME.github.io`.
3. **Create the database:** Build → Firestore Database → Create (production mode).
   Open the **Rules** tab, paste the contents of `firestore.rules`, click **Publish**.
4. **Lock the API key to your site:** Google Cloud Console → APIs & Services → Credentials → open the "Browser key (auto created by Firebase)".
   - Application restrictions → **Websites** → add `https://YOURNAME.github.io/*` (add `http://localhost:*/*` too if you test locally).
   - API restrictions → **Restrict key** → allow *Identity Toolkit API*, *Token Service API*, *Cloud Firestore API* and *Firebase Installations API*.
5. **Publish:** push these files to a GitHub repo → Settings → Pages → Deploy from branch → `main` / root.

### How the lock works
A Firebase web API key always ends up in the page source — that's by design, so it can't be "hidden" on a static site. What actually locks things down:
- the **referrer restriction** (step 4) means the key only works from your GitHub Pages domain,
- **Firestore rules** mean only signed-in users who joined through a valid invite can read an event, only the host can change event details/categories, and only an item's owner (or the host) can edit it,
- the history log can't be edited or deleted by anyone.

For extra protection you can turn on **Firebase App Check** (reCAPTCHA v3) later.

## Data layout
```
events/{eventId}               title, location, when, notes, ownerUid, inviteToken
  members/{uid}                name, email, photo, role, token
  categories/{id}              name, order
  items/{id}                   name, categoryId, quantity, notes, uid, deleted
  history/{id}                 type, summary, actorName, at, before, after
users/{uid}/events/{eventId}   pointer to potlucks you host or joined
```

## Local testing
Serve the folder (e.g. `npx serve .`) and add `localhost` under Authorized domains. Opening `index.html` directly from disk won't work with Google sign-in.
