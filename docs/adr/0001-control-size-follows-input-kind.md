# Control size follows the input kind, not the screen width

Every control used to be at least 44px so that one size served touch and mouse at any width. On desktop that size, and the rows built around it, pushed the Library list to 53% of the viewport height and left six visible rows. We now keep two sizes: 44px controls and 48px rows when the primary pointer is coarse, 28px controls and 40px rows when it is fine. The ⋮ menu can override the detected kind. Android keeps the same screen with the touch size, so there is no second layout to maintain.

## Considered Options

- **Keep 44px everywhere.** Recomposing the screen alone moved the narrow Library list from 544px to 116px without shrinking a control, but desktop rows and toolbars stayed large and a DJ mode with many controls would not fit.
- **Choose the size by width.** A narrow desktop window would get touch controls and a wide tablet would get mouse controls.
- **A separate Android screen.** Two layouts to design, test and keep in step for a difference that is only size.

## Consequences

The 28px mouse size exceeds the 24px minimum of WCAG 2.5.8 and no longer meets the 44px of 2.5.5; the touch size still does. A touch-screen PC usually reports a fine primary pointer and so gets the mouse size until the user picks the touch size in the ⋮ menu.
