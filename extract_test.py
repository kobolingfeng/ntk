from pydnfex.npk import NPK
from pydnfex.img import IMGFactory
import io
import os

NPK_DIR = r"D:\WeGameApps\地下城与勇士：创新世纪\ImagePacks2"

npk_files = [
    "sprite_interface2_ui_skillshop_newskilluseguide_skill.NPK",
    "sprite_interface2_ui_skillshop_newskilluseguide.NPK",
    "sprite_interface2_newskillshop.NPK",
    "sprite_interface2_ui_newskillshop.NPK",
    "sprite_interface2_ui_skillshop.NPK",
    "sprite_interface2_ui_skillshop2.NPK",
]

for npk_name in npk_files:
    path = os.path.join(NPK_DIR, npk_name)
    if not os.path.exists(path):
        print(f"\n{npk_name}: NOT FOUND")
        continue
    f = open(path, "rb")
    try:
        npk = NPK.open(f)
        print(f"\n=== {npk_name} ({len(npk.files)} files) ===")
        for i, nf in enumerate(npk.files[:30]):
            name = os.path.basename(nf.name)
            nf.load()
            img = IMGFactory.open(io.BytesIO(nf.data))
            img.load_all()
            frame_count = len(img.images)
            sizes = []
            for im in img.images[:3]:
                try:
                    im.load(force=True)
                    sizes.append(f"{im.w}x{im.h}")
                except:
                    sizes.append("?")
            more = "..." if frame_count > 3 else ""
            print(f"  [{i}] {name}: {frame_count} frames, sizes=[{', '.join(sizes)}{more}]")
    except Exception as e:
        print(f"  Error: {e}")
    finally:
        f.close()
