# Synthetic Mastery Guide: Ecosystem Change

This fictional fixture provides a second subject shape for tutor evaluation.

```xml
<concept_graph>
  <concept id="S01_Energy_Source"><concept_name>Energy Source</concept_name><definition>Most ecosystem energy begins with sunlight.</definition></concept>
  <concept id="S02_Producers"><concept_name>Producers</concept_name><definition>Producers transform light energy into stored chemical energy.</definition></concept>
  <concept id="S03_Consumers"><concept_name>Consumers</concept_name><definition>Consumers obtain energy by eating other organisms.</definition></concept>
  <concept id="S04_Decomposers"><concept_name>Decomposers</concept_name><definition>Decomposers return matter to the environment.</definition></concept>
  <concept id="S05_Food_Webs"><concept_name>Food Webs</concept_name><definition>Food webs show connected feeding relationships.</definition></concept>
  <concept id="S06_Limiting_Factors"><concept_name>Limiting Factors</concept_name><definition>Resources and conditions constrain population growth.</definition></concept>
  <concept id="S07_Disturbance"><concept_name>Disturbance</concept_name><definition>A disturbance changes resources or relationships.</definition></concept>
  <concept id="S08_System_Prediction"><concept_name>System Prediction</concept_name><definition>A prediction traces causal effects through the web.</definition></concept>
  <dependency from="S01_Energy_Source" to="S02_Producers" type="prerequisite_of" />
  <dependency from="S02_Producers" to="S03_Consumers" type="prerequisite_of" />
  <dependency from="S02_Producers" to="S04_Decomposers" type="prerequisite_of" />
  <dependency from="S03_Consumers" to="S05_Food_Webs" type="prerequisite_of" />
  <dependency from="S04_Decomposers" to="S05_Food_Webs" type="prerequisite_of" />
  <dependency from="S05_Food_Webs" to="S06_Limiting_Factors" type="prerequisite_of" />
  <dependency from="S05_Food_Webs" to="S07_Disturbance" type="prerequisite_of" />
  <dependency from="S06_Limiting_Factors" to="S08_System_Prediction" type="prerequisite_of" />
  <dependency from="S07_Disturbance" to="S08_System_Prediction" type="prerequisite_of" />
  <dependency from="S04_Decomposers" to="S06_Limiting_Factors" type="related_to" />
</concept_graph>
```

<concept_essay concept_id="S01_Energy_Source"><title>Sunlight starts the flow</title><content>Energy enters most food webs as sunlight captured by producers.</content></concept_essay>
<concept_essay concept_id="S05_Food_Webs"><title>Connected effects</title><content>A change to one population can affect several connected populations.</content></concept_essay>
<concept_essay concept_id="S08_System_Prediction"><title>Causal prediction</title><content>State the disturbance, trace each link, and acknowledge uncertainty.</content></concept_essay>

<question_block difficulty="Easy"><concept_id>S01_Energy_Source</concept_id><question_text>What is the main starting energy source?</question_text></question_block>
<question_block difficulty="Medium"><concept_id>S05_Food_Webs</concept_id><question_text>Trace energy through three organisms.</question_text></question_block>
<question_block difficulty="Difficult"><concept_id>S08_System_Prediction</concept_id><question_text>Predict two effects of removing a producer.</question_text></question_block>
