/*
@title Firefly
@author Futuro Cube Suite
@about A firefly flits around the cube. Tilt so your cursor (the up-facing square, blue) is under it and tap to catch it. Catch ten as fast as you can; it gets jumpier as you go.
*/

#include <futurocube>

new icon[] = [ICON_MAGIC1, ICON_MAGIC2, 2, 5,
  0, 0, 0,
  0, 0xFFE00000, 0,
  0, 0x0030FF00, 0,
  '''', '''']

new fly
new caught
new hop_ms

place_fly()
{
  // somewhere new, not on the cursor's side
  new cur = _side(GetCursor())
  do
    fly = GetRnd(54)
  while (_side(fly) == cur)
}

main()
{
  ICON(icon)
  SetRndSeed(GetMsecs())
  RegMotion(TAP_GENERIC)
  Play("startapp")
  place_fly()
  caught = 0
  hop_ms = 1600
  SetTimer(0, hop_ms)
  new start = GetAppMsecs()

  for (;;)
  {
    Sleep()
    new cursor = _i(GetCursor())

    if (Motion())
    {
      if (cursor == fly)
      {
        caught++
        Play("bubble")
        Vibrate(80)
        if (caught >= 10)
        {
          // score: seconds taken, fewer is better (under 30 is a win)
          new secs = (GetAppMsecs() - start) / 1000
          Score(secs, secs < 30 ? SCORE_WINNER : SCORE_NORMAL)
          caught = 0
          hop_ms = 1600
          start = GetAppMsecs()
        }
        else
          hop_ms = hop_ms * 9 / 10
        place_fly()
        SetTimer(0, hop_ms)
      }
      else
        Play("uff")
      AckMotion()
    }

    // the firefly hops to a neighbouring square now and then
    if (GetTimer(0) == 0)
    {
      new w = _w(fly)
      WalkerTurn(w, GetRnd(2) ? TURN_LEFT : TURN_RIGHT)
      WalkerMove(w)
      fly = _i(w)
      SetTimer(0, hop_ms)
    }

    ClearCanvas()
    SetColor(0xFFE00000)
    DrawFlicker(fly, 30)
    // progress: one dim green square per catch on the bottom side
    for (new i = 0; i < caught && i < 9; i++)
      DrawPC(_w(5, i), cGREEN, 40)
    DrawPC(cursor, cursor == fly ? WHITE : 0x0030FF00)
    PrintCanvas()
  }
}
