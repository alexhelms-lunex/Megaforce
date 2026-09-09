# Linkpoint Elen Construction — Website

A single-page website in plain HTML/CSS/JS. No build step, no framework, no
dependencies. Upload the files and it works.

```
index.html          the entire site (HTML + CSS + JavaScript in one file)
contact.php         optional form handler (only if you don't use FormSubmit)
images/             13 real project photos, already resized and compressed
README-DEPLOY.md    this file
```

Everything is already wired up with the real phone number and the real form
destination. **The only mandatory step before launch is activating the contact
form (section 2).**

---

## 1. Upload to Hostinger

1. Log in to Hostinger → **hPanel**.
2. Open **Files → File Manager**.
3. Go into the `public_html` folder.
4. Delete anything already there (Hostinger leaves a `default.php` placeholder).
5. Upload `index.html` and the whole `images` folder. Add `contact.php` only if
   you choose Option B in the next section.

`public_html` should end up looking like:

```
public_html/
├── index.html
└── images/
    ├── hero.jpg
    ├── about.jpg
    ├── cta.jpg
    └── work-01-…  through  work-10-…
```

6. Visit your domain.

**Turn on free SSL** in hPanel under **Security → SSL** so the site loads over
`https://`. Browsers show a "Not secure" warning without it.

---

## 2. Activate the contact form — REQUIRED

The form posts to **FormSubmit**, which needs no account and no API key, and
delivers to **alexhelms@lunexmarketing.com**.

FormSubmit requires a one-time confirmation before it will forward anything:

1. Publish the site.
2. Fill in the form on the live site once and submit it.
3. FormSubmit emails **alexhelms@lunexmarketing.com** asking you to confirm.
4. Click the link in that email.

Every submission after that is forwarded automatically. **Until step 4 is done,
leads are not delivered.** Do this before you send any traffic to the site.

### Two follow-ups worth doing

**Hide the address from the page source.** The confirmation email contains a
random alias URL like `https://formsubmit.co/ajax/a1b2c3d4e5…`. Paste that into
the form's `action="..."` in `index.html` in place of the plain email address.
Right now the address sits in the HTML where spam bots can scrape it.

**Change the destination** by editing that same `action="..."` — it's the only
place the address appears. Search `index.html` for `formsubmit`.

### Option B — Hostinger PHP instead

If you'd rather not use a third party: set `$TO_EMAIL` in `contact.php`, upload
it, change the form's `action` to `action="contact.php"`, and delete the four
hidden `_subject` / `_template` / `_captcha` / `_honey` inputs. Shared-hosting
PHP mail lands in spam more often, which is why FormSubmit is the default.

---

## 3. Still to fill in

Search `index.html` for the word **EDIT** — every spot that needs attention is
flagged with a comment.

| What | Currently | Where |
|---|---|---|
| Domain name | `https://www.linkpointelen.com/` | 4 SEO tags + the JSON-LD block |
| Facebook URL | `https://www.facebook.com/` | footer |
| Business hours | `Mon–Sat, 8am–6pm` | contact section |
| The three stats | `5.0` / `100%` / `Free` | About section |

The phone number **(513) 709-2118** is already live everywhere it appears.

There is deliberately **no email address shown** on the page, since there's no
business mailbox yet — visitors get the phone number and the form. When a real
address exists (`info@` on the domain), add it back to the contact block, the
footer, and the JSON-LD.

**Read the About section.** It says the trade was learned in Ukraine and that
the business runs on referrals. Adjust anything that isn't accurate. Same for
"Licensed & Insured" in the trust bar and footer — only keep it if it's true.

---

## 4. The photos

All 13 photos are real project work, already resized and compressed (about
1.9 MB total, which is fine for a page this size).

| File | Used for |
|---|---|
| `hero.jpg` | Vaulted shiplap ceiling — top of the page |
| `about.jpg` | Oak newel post & iron balusters — About section |
| `cta.jpg` | Backlit feature wall — behind the dark call-to-action band |
| `work-01-shower-tile.jpg` | Large-format porcelain shower |
| `work-02-signage-backlit.jpg` | Backlit signage wall |
| `work-03-signage-wall.jpg` | Panelled accent wall |
| `work-04-signage-install.jpg` | Layout & install |
| `work-05-loft.jpg` | A-frame loft renovation |
| `work-06-outbuilding.jpg` | Custom outbuilding |
| `work-07-deck.jpg` | Composite deck build |
| `work-08-dormer-window.jpg` | Dormer window & trim |
| `work-09-letters-wiring.jpg` | Backlit letter wiring |
| `work-10-attic-framing.jpg` | Attic conversion |

The gallery is a masonry layout, so photos keep their own shape — nothing gets
cropped, and portrait and landscape can be mixed freely. Clicking any photo
opens it full-size (arrow keys and Esc work).

### Adding or swapping photos

Drop the file into `images/` and copy one `<button class="gal__i">` block in the
gallery. Three things matter:

- **Set `width` and `height`** on the `<img>` to the real pixel size, or the
  page will jump around while images load.
- **Compress first.** Phone photos are 5–10 MB. Run them through
  [squoosh.app](https://squoosh.app) or [tinypng.com](https://tinypng.com) and
  aim for under 300 KB, longest edge around 1300px.
- **Order matters.** The masonry fills column 1 top-to-bottom, then column 2,
  then column 3. With 10 photos that means photos **1, 5 and 8** land at the
  top of a column on desktop — put your strongest work in those slots.

### Worth shooting next

The two things that would most improve this site:

1. **A photo of Vitalii.** The About section currently shows a staircase because
   there's no portrait available. Save one as `images/about.jpg` (portrait,
   roughly 900×1125) and change the caption back to his name and title — there's
   an EDIT comment in the file showing exactly where.
2. **Finished kitchens and bathrooms.** The services section leads with kitchen
   and bath remodeling, but the gallery has no finished kitchen. Wide shot of
   the room, then two or three tight shots of the details. Before/after pairs
   perform especially well for this kind of work.

---

## 5. After launch

- **Google Business Profile** matters more than the website for a local
  contractor. Claim it at [business.google.com](https://business.google.com),
  link the site, and ask every happy customer to review there. The site already
  includes `LocalBusiness` structured data (the JSON block near the bottom of
  `index.html`) — update the domain in it to match.
- **Reviews.** There's no testimonials section, because inventing reviews for a
  real business isn't worth doing. Once there are four or five real ones, that
  section is usually the highest-converting thing on a contractor's site.

---

## Editing tips

Everything lives in `index.html`, in the order it appears on the page. Section
markers look like `<!-- ============ SERVICES ============ -->`.

Colours are set once at the top of the `<style>` block:

```css
--brass:#8F6F3E;   /* the gold accent colour */
--char:#1B1A16;    /* dark section backgrounds */
--bone:#FAF8F5;    /* page background */
```

Change those three and the whole site re-themes.

One gotcha: HTML comments can't be nested. If you comment something out and the
page suddenly shows stray text, check that you haven't wrapped a comment that
already contains `-->`.
