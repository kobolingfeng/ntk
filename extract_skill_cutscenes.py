"""
Extract skill cutscene images from DNF NPK files.
Organizes output by character class.
"""
from pydnfex.npk import NPK
from pydnfex.img import IMGFactory
from PIL import Image
import io
import os
import re

NPK_PATH = r"D:\WeGameApps\地下城与勇士：创新世纪\ImagePacks2\sprite_interface_skillcutscene.NPK"
OUT_BASE = r"d:\projects\ntk\dnf_skill_cutscenes"

CLASS_MAP = {
    "ghost": "鬼剑士(男)",
    "ghostf": "鬼剑士(女)",
    "fighter": "格斗家(女)",
    "atfighter": "格斗家(男)",
    "gunner": "神枪手(男)",
    "atgunner": "神枪手(女)",
    "mage": "魔法师(女)",
    "magem": "魔法师(男)",
    "priest": "圣职者(男)",
    "priestf": "圣职者(女)",
    "thief": "暗夜使者",
    "knightf": "女圣骑士",
    "deminiclancer": "枪剑士",
    "gunblader": "外传职业",
    "archer": "弓箭手",
    "hangawi": "其他",
}

SUBCLASS_NAMES = {
    "asura": "阿修罗",
    "berserker": "狂战士",
    "ghostsword": "鬼泣",
    "soul": "灵魂行者",
    "weapon": "剑魂",
    "blade": "剑影",
    "darktempler": "暗殿骑士",
    "demonslayer": "驭剑士",
    "vegabond": "剑宗",
    "grap": "柔道家",
    "nenma": "气功师",
    "streetf": "散打",
    "striker": "武极",
    "diva": "唤舞师",
    "ranger": "漫游枪手",
    "launcher": "重炮手",
    "mecha": "机械师",
    "spitfire": "弹药专家",
    "spit": "弹药专家",
    "assault": "征战者",
    "battle": "战斗法师",
    "elma": "元素师",
    "enchantress": "魔道学者",
    "hecate": "赫卡忒",
    "mado": "魔道",
    "summon": "召唤师",
    "bloodmage": "血法师",
    "dimensionwalker": "次元行者",
    "elbo": "元素爆破师",
    "glma": "冰结师",
    "swiftmaster": "风暴骑士",
    "avenger": "复仇者",
    "crusader": "圣骑士",
    "exocist": "驱魔师",
    "infighter": "蓝拳圣使",
    "inquisitor": "异端审判者",
    "mistress": "巫女",
    "sorceress": "魔女",
    "rogue": "刺客",
    "kunoich": "忍者",
    "necro": "死灵术士",
    "shadowdancer": "影舞者",
    "chaos": "混沌骑士",
    "dragonknight": "龙骑士",
    "elvenknight": "精灵骑士",
    "paladin": "守护者",
    "darklancer": "暗枪士",
    "dragonianlancer": "龙枪士",
    "duelist": "决斗家",
    "vanguard": "征战者",
    "agent": "暗影特工",
    "hitman": "刺客",
    "specialist": "特工",
    "troubleshooter": "麻烦终结者",
    "hunter": "猎人",
    "muse": "缪斯",
    "traveler": "旅行者",
    "vigilante": "义勇军",
    "chimera": "奇美拉",
}

FORMAT_CONVERTERS = {
    (14, 5): "BGRA",   # ARGB 1555 or similar
    (16, 5): "BGRA",   # ARGB 8888 uncompressed
    (16, 6): "BGRA",   # ARGB 8888 zlib compressed
    (15, 5): "BGRA",   # ARGB 4444
    (15, 6): "BGRA",
    (17, 5): "BGRA",
    (17, 6): "BGRA",
    (18, 5): "BGRA",
    (18, 6): "BGRA",
}

def classify_file(name):
    basename = os.path.basename(name).replace(".img", "")
    basename = re.sub(r"^\(.*?\)", "", basename)
    basename = re.sub(r"_event$", "", basename)
    basename = re.sub(r"_tn$", "", basename)

    parts = basename.split("_", 1)
    class_key = parts[0]
    subclass_key = parts[1] if len(parts) > 1 else ""

    class_name = CLASS_MAP.get(class_key, class_key)
    subclass_name = SUBCLASS_NAMES.get(subclass_key, subclass_key)
    return class_name, subclass_name, basename


def extract_image(image):
    image.load(force=True)
    w, h = image.w, image.h
    if w <= 0 or h <= 0:
        return None

    data = image.data
    if data is None or len(data) == 0:
        return None

    bpp = len(data) // (w * h) if w * h > 0 else 0

    if bpp == 4:
        return Image.frombytes("RGBA", (w, h), data, "raw", "BGRA")
    elif bpp == 2:
        pixels = []
        for i in range(0, len(data), 2):
            val = int.from_bytes(data[i:i+2], "little")
            a = ((val >> 15) & 1) * 255
            r = ((val >> 10) & 0x1F) * 255 // 31
            g = ((val >> 5) & 0x1F) * 255 // 31
            b = (val & 0x1F) * 255 // 31
            pixels.extend([r, g, b, a])
        return Image.frombytes("RGBA", (w, h), bytes(pixels))
    else:
        try:
            return Image.frombytes("RGBA", (w, h), data, "raw", "BGRA")
        except:
            return None


def main():
    os.makedirs(OUT_BASE, exist_ok=True)

    f = open(NPK_PATH, "rb")
    npk = NPK.open(f)

    print(f"Total files in NPK: {len(npk.files)}")
    success = 0
    fail = 0

    for idx, nf in enumerate(npk.files):
        class_name, subclass_name, basename = classify_file(nf.name)
        out_dir = os.path.join(OUT_BASE, class_name)
        os.makedirs(out_dir, exist_ok=True)

        nf.load()
        img = IMGFactory.open(io.BytesIO(nf.data))
        img.load_all()

        for frame_idx, image in enumerate(img.images):
            try:
                pil_img = extract_image(image)
                if pil_img:
                    suffix = f"_f{frame_idx}" if len(img.images) > 1 else ""
                    filename = f"{basename}{suffix}.png"
                    out_path = os.path.join(out_dir, filename)
                    pil_img.save(out_path)
                    success += 1
                    print(f"  [{idx}] {class_name}/{filename} ({pil_img.size[0]}x{pil_img.size[1]})")
                else:
                    fail += 1
            except Exception as e:
                fail += 1
                print(f"  [{idx}] ERROR {basename}: {e}")

    f.close()
    print(f"\nDone! Success: {success}, Failed: {fail}")
    print(f"Output directory: {OUT_BASE}")

    for d in sorted(os.listdir(OUT_BASE)):
        dp = os.path.join(OUT_BASE, d)
        if os.path.isdir(dp):
            count = len([f for f in os.listdir(dp) if f.endswith(".png")])
            print(f"  {d}: {count} files")


if __name__ == "__main__":
    main()
