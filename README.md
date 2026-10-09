# Futuro Cube community library

Games and apps for the Rubik's Futuro Cube, shared by cube owners. They show up in the
**Community** section of the [Futuro Cube Suite](https://futuro.triplejdeveloping.com/)
gallery, where anyone can try them in the simulator, read the code, or install them on
their cube.

## Share a script

The easy way: open your script in the Suite's **Code** tab and click **Share…**. It saves
the file and opens this repo's upload page; drag the file in and GitHub opens a pull
request for you. You need a free GitHub account.

Or open a pull request yourself that adds one file, `scripts/<name>.p`.

### What makes a good submission

- **One file**, `scripts/<name>.p`: letters, digits and `_`, starting with a letter (max 30).
- **It compiles** with the cube's settings (the Suite's Compile button checks this) and
  calls `Sleep()` in its main loop. A check runs on every pull request.
- **Describe it** in the first comment. These lines fill in its gallery card:

  ```c
  /*
  @title Firefly
  @author Your name
  @about One or two sentences: what it does and how to play.
  */
  ```

  Without them, the card uses the file name and the comment's first paragraph.
- **A menu icon** (`icon[]` plus `ICON(icon)`) lets people install it in a menu. Any slot
  is fine; people can move it in the Suite's Menus tab.
- Your own work, and nothing unkind.

By sharing, you agree to license your script under the MIT licence (see [LICENSE](LICENSE)).

## Featured

`featured.json` lists the maintainer's picks, in order. They show first in the gallery
with a **Featured** badge. Pull requests that change it won't be merged; just ask.

```json
{ "featured": ["firefly"] }
```

## How it works

`tools/build_index.mjs` compiles every script with the Suite's Pawn compiler, runs each one
for a few seconds in the Suite's cube simulator to record the gallery preview, and writes
`index.json` and `previews.json`. A GitHub Action runs it as a check on pull requests and
rebuilds the index when something is merged. `tools/vendor/` holds the compiler and
simulator, copied from [rmjjjt/futuro_cube](https://github.com/rmjjjt/futuro_cube).

Unofficial community project. Not affiliated with or endorsed by Rubik's Brand Ltd.
