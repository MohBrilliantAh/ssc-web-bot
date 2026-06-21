import pandas as pd
from rouge_score import rouge_scorer
from tabulate import tabulate

# =====================================================
# LOAD CSV
# =====================================================

CSV_FILE = "evaluation_with_prediction.csv"

df = pd.read_csv("evaluation_with_prediction.csv")

print(f"\nTotal data pada CSV : {len(df)}")

# =====================================================
# ROUGE SCORER
# =====================================================

scorer = rouge_scorer.RougeScorer(
    ["rouge1", "rouge2", "rougeL"],
    use_stemmer=True
)

hasil = []

r1_all = []
r2_all = []
rl_all = []

# =====================================================
# EVALUASI PER DATA
# =====================================================

for _, row in df.iterrows():

    question = str(row["question"])
    reference = str(row["reference"])
    prediction = str(row["prediction"])

    # Skip jika prediction kosong
    if prediction.strip() == "" or prediction.lower() == "nan":
        continue

    score = scorer.score(
        reference,
        prediction
    )

    rouge1 = score["rouge1"].fmeasure
    rouge2 = score["rouge2"].fmeasure
    rougel = score["rougeL"].fmeasure

    r1_all.append(rouge1)
    r2_all.append(rouge2)
    rl_all.append(rougel)

    hasil.append([
        question,
        round(rouge1, 4),
        round(rouge2, 4),
        round(rougel, 4)
    ])

# =====================================================
# VALIDASI
# =====================================================

if len(hasil) == 0:
    print("\n[ERROR] Tidak ada prediction yang bisa dievaluasi.")
    print("Pastikan kolom prediction tidak kosong.")
    exit()

# =====================================================
# HASIL INDIVIDUAL
# =====================================================

print("\n" + "=" * 100)
print("HASIL EVALUASI INDIVIDUAL (F1-SCORE)")
print("=" * 100)

print(
    tabulate(
        hasil,
        headers=[
            "Question",
            "ROUGE-1 F1",
            "ROUGE-2 F1",
            "ROUGE-L F1"
        ],
        tablefmt="grid"
    )
)

# =====================================================
# HASIL AGREGAT
# =====================================================

avg_r1 = sum(r1_all) / len(r1_all)
avg_r2 = sum(r2_all) / len(r2_all)
avg_rl = sum(rl_all) / len(rl_all)

agregat = [
    ["ROUGE-1 F1", round(avg_r1, 4)],
    ["ROUGE-2 F1", round(avg_r2, 4)],
    ["ROUGE-L F1", round(avg_rl, 4)]
]

print("\n")
print("=" * 50)
print("HASIL EVALUASI AGREGAT (CORPUS-LEVEL)")
print("=" * 50)

print(
    tabulate(
        agregat,
        headers=["Metric", "Average Score"],
        tablefmt="grid"
    )
)

# =====================================================
# SIMPAN HASIL
# =====================================================

hasil_df = pd.DataFrame(
    hasil,
    columns=[
        "Question",
        "ROUGE-1 F1",
        "ROUGE-2 F1",
        "ROUGE-L F1"
    ]
)

hasil_df.to_csv(
    "hasil_evaluasi_rouge.csv",
    index=False
)

print("\nJumlah data dievaluasi :", len(hasil))
print("File hasil tersimpan : hasil_evaluasi_rouge.csv")

print("\n[SUCCESS] Evaluasi ROUGE selesai.")