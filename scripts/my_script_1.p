/*
@author rhymes
New script. Tilt the cube and the up-facing square lights up.
*/

#include <futurocube>

new icon[]=[ICON_MAGIC1, ICON_MAGIC2, 3, 0,
	0, 0, 0, 0, WHITE, 0, 0, 0, 0,
	'''', '''']

main()
{
  ICON(icon)
  for (;;)
  {
    Sleep()
    ClearCanvas()
    SetColor(WHITE)
    DrawPoint(GetCursor())
    PrintCanvas()
  }
}
