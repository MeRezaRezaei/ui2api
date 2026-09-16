# Verbatim: V1 Gate — Login Made Simple (xhost display sharing + Chrome profile scan + identity-keyed multi-account)

> **Authoritative source**: the original words live in [`raw/VERBATIM-RAW.md`](raw/VERBATIM-RAW.md).
> This copy is the spelling/grammar-corrected presentation. If this file and the raw file ever
> differ, the raw file is the truth. This is a **v1 done-condition**: the first version of
> ui2api is NOT done until this works in the real world, end to end.
>
> Rule (like the rest of the verbatims): **read the verbatim each time the session compacts,
> and keep working until the goal works in real world end to end.**

## The core problem

The way the login works is not what is needed. It is **too hard for the end user**. This tool
has a lot of use cases and a lot of people who might actually install it — and those people
necessarily do not have many skills to work with it. Since two days ago, when we finally got
one correct answer from Gemini, the constant question has been: **how to make it more simple.**

## The mechanism (Linux xhost+)

On Linux there is a command called `xhost +` — it lets one screen be used from other users.
Since for our work we are making a user named **`ui2api`**, we should also preserve the option
for handling our logins this way, simply by hitting it:

- The only thing the user must do is **use the browser and log in to whatever account it wants,
  the regular way.**
- The only difference: the command has **released the lock of the display** (`xhost +`), and
  the data will be stored **in the ui2api user**, not in the current user that is using it.
- This is **the most reliable way to do it.**

## Chrome profile scanning (checkbox indexing)

There should be more options for this. Chrome stores data — localStorage and cookies — for
anything, just based on **site domain**. So our tool can simply **scan the Linux of our user**
and find out any site whose info exists among **any profile of Chrome that can be found in the
OS**. It is only a matter of a **checkbox** for indexing and inserting whatever our user wants
to store.

## Identity-keyed multi-account sessions

Users are not necessarily using one set of login or localStorage. **One user might have several
Gemini accounts** and want to use all of them. So it is logical that we store the data and the
site in a **specific situation related to specific auth info** — email, or whatever the site
functionality possesses. This way we grant users the ability to:

- use **any account** they want for this, or
- **aggregate** them as they want, or
- for **future development** (not now): the ability to use **cross-site data** — since while we
  have all the functionality as an API, we can orchestrate them as needed for many reasons one
  person may need.

## Definition of done (v1)

1. `xhost+`-style capture exists: the user logs in in a real visible browser, the display lock
   is released, data lands in the `ui2api` user's store.
2. OS scan exists: the tool finds any site with data among any Chrome profile in the OS and
   offers checkbox-style indexing/import.
3. Sessions are stored **identity-keyed** (per site + per auth identity, e.g. email): multiple
   accounts per site are selectable and aggregatable.
4. All of it works **end to end in the real world**.