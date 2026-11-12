ENTRY(m4_run)
MEMORY
{
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 12M
}
SECTIONS
{
  .text : { *(.text*) *(.rodata*) } > RAM
  .init_array : { __init_array_start = .; KEEP(*(SORT(.init_array.*))) KEEP(*(.init_array)) __init_array_end = .; } > RAM
  .preinit_array : { __preinit_array_start = .; KEEP(*(.preinit_array)) __preinit_array_end = .; } > RAM
  .data : { *(.data*) } > RAM
  .bss : { *(.bss*) *(COMMON) } > RAM
  /DISCARD/ : { *(.ARM.exidx*) *(.ARM.extab*) *(.comment) }
}
