# Linkpoint Elen Construction — Website

A single-page website, built as plain HTML/CSS/JS. No build step, no framework,
no dependencies. Upload the files and it works.

```
index.html        the entire site (HTML + CSS + JavaScript in one file)
contact.php       optional form handler (only if you don't use Web3Forms)
images/           9 placeholder images to replace with real photos
```

---

## 1. Before you upload — things you MUST change

Open `index.html` in any text editor and search for the word **EDIT**. Every spot
that needs your real information is flagged with an `EDIT` comment.

| What | Placeholder currently in the file | Appears in |
|---|---|---|
| Phone number | `(513) 555-0100` / `+15135550100` | 4 places |
| Email address | `info@linkpointelen.com` | 3 places |
| Domain name | `https://www.linkpointelen.com/` | 4 places (SEO tags) |
| Facebook URL | `https://www.facebook.com/` | footer |
| Business hours | `Mon–Sat, 8am–6pm` | contact section |
| The three stats | `5.0` / `100%` / `Free` | About section |

> **Fastest way:** use Find & Replace. Replace `5135550100` with your real digits,
> then `(513) 555-0100` with your real formatted number, then `info@linkpointelen.com`
> with your real email, then `www.linkpointelen.com` with your real domain.

**A note on the copy:** the About section says the trade was learned in Ukraine and
that the business runs on referrals. Read it over and adjust anything that isn't
accurate. Same for "Licensed & Insured" in the trust bar and footer — only keep
that if it's true for your business in Ohio.

---

## 2. Replace the photos

The `images/` folder has 9 placeholders. Each one has its purpose and ideal size
printed right on the image. **Replace each file, keeping the exact same file name**,
and the layout stays exactly as designed.

| File | Size | What it should be |
|---|---|---|
| `hero.jpg` | 1600 × 900 | Your single best finished interior. Wide shot. |
| `about-vitalii.jpg` | 800 × 1000 | Portrait photo of Vitalii, ideally on a job site. |
| `cta.jpg` | 1600 × 700 | Any wide interior shot (sits behind a dark overlay). |
| `work-01.jpg` | 1200 × 750 | Kitchen remodel — landscape |
| `work-02.jpg` | 600 × 750 | Bathroom / tiled shower — portrait |
| `work-03.jpg` | 600 × 750 | Wainscoting & trim — portrait |
| `work-04.jpg` | 1200 × 750 | Tile floor — landscape |
| `work-05.jpg` | 900 × 600 | Finished basement — landscape |
| `work-06.jpg` | 900 × 600 | Built-ins & millwork — landscape |

They don't have to match those pixel sizes exactly — just get the **orientation**
right (landscape vs portrait), or the photo will be cropped oddly.

**Compress your photos before uploading.** Phone photos are often 5–10 MB and will
make the site slow. Run them through [squoosh.app](https://squoosh.app) or
[tinypng.com](https://tinypng.com) and aim for under 300 KB each.

Also update the captions under each photo in the gallery (search for `figcaption`)
and the `alt="..."` text, which is what Google reads and what screen readers announce.

---

## 3. Make the contact form actually send email

The form is wired up but **will not send anything until you do one of these two.**

### Option A — Web3Forms (recommended, takes 2 minutes)

1. Go to [web3forms.com](https://web3forms.com), enter your email, get a free access key.
2. In `index.html`, find `PASTE-YOUR-WEB3FORMS-KEY-HERE` and replace it with your key.
3. Done. Submissions arrive in your inbox. Free tier covers 250/month.

You can then delete `contact.php` — you won't need it.

### Option B — Hostinger's built-in PHP mail

1. Open `contact.php`, set `$TO_EMAIL` to your address and `$FROM_EMAIL` to an
   address on your own domain (Hostinger rejects sends from other domains).
2. In `index.html`, change the form tag from
   `action="https://api.web3forms.com/submit"` to `action="contact.php"`.
3. Delete the hidden `access_key` input line just below it.

Option A is more reliable — shared-hosting PHP mail often lands in spam.

**Either way: test it.** Submit the form yourself and confirm the email arrives.
Check your spam folder on the first try.

---

## 4. Upload to Hostinger

1. Log in to Hostinger → **hPanel**.
2. Open **Files → File Manager**.
3. Go into the `public_html` folder.
4. Delete anything already in there (a `default.php` placeholder page is usually present).
5. Upload `index.html`, the whole `images` folder, and `contact.php` if you're using it.

Your structure in `public_html` should look like:

```
public_html/
├── index.html
├── contact.php        (only if using Option B)
└── images/
    ├── hero.jpg
    ├── about-vitalii.jpg
    ├── cta.jpg
    └── work-01.jpg … work-06.jpg
```

6. Visit your domain. That's it.

**Turn on free SSL** in hPanel under **Security → SSL** so the site loads as
`https://` — Google penalises sites without it, and browsers show a "Not secure"
warning to visitors.

---

## 5. After launch

- **Google Business Profile.** For a local contractor this matters more than the
  website itself. Create/claim it at [business.google.com](https://business.google.com),
  put the website link on it, and ask every happy customer for a review there.
  The site already includes `LocalBusiness` structured data (the JSON block at the
  bottom of `index.html`) so Google can connect the two — update the phone, email
  and domain in that block too.
- **Ask for reviews.** There's currently no testimonials section on the page,
  because I wasn't going to write fake ones. Once you have 4–5 real reviews, they're
  worth adding — that's usually the single highest-converting thing on a
  contractor's site.
- **Photos are your marketing.** For this kind of work, the gallery does more
  selling than any copy. Shoot every finished job: wide shot of the room, then 2–3
  tight shots of the details you're proud of. Before/after pairs perform especially
  well.

---

## Editing tips

Everything is in `index.html`, in the order it appears on the page. Section markers
look like `<!-- ============ SERVICES ============ -->` so you can find things fast.

Colours are set once at the very top of the `<style>` block:

```css
--brass:#8F6F3E;   /* the gold accent colour */
--char:#1B1A16;    /* dark section backgrounds */
--bone:#FAF8F5;    /* page background */
```

Change those three and the whole site re-themes.
